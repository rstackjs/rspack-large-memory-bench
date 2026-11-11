//! Diagnostic allocator: independent byte sampling, live blocks and cumulative sites.
//! Payloads still use mimalloc. Profiler bookkeeping is excluded from sampled totals.
#![allow(unsafe_code, unsafe_op_in_unsafe_fn)]
use std::{alloc::{GlobalAlloc, Layout}, cell::Cell, collections::HashMap, ffi::c_void,
    fs, fmt::Write, sync::{atomic::{AtomicBool, AtomicU64, Ordering}, LazyLock, Mutex, RwLock}, time::Duration};

const INTERVAL: usize = 65536;
const DEPTH: usize = 48;
const SHARDS: usize = 64;
thread_local! {
    static BUSY: Cell<bool> = const { Cell::new(false) };
    static RANDOM: Cell<u64> = const { Cell::new(0) };
}
static SEED: AtomicU64 = AtomicU64::new(1);
static ACTIVE: AtomicBool = AtomicBool::new(false);
static STOP: AtomicBool = AtomicBool::new(false);
static GATE: RwLock<()> = RwLock::new(());
static DUMP: Mutex<()> = Mutex::new(());
#[derive(Clone, Copy)]
struct Block { site: usize, bytes: f64, count: f64 }
#[derive(Clone)]
struct Site { frames: Vec<usize>, allocated: f64, count: f64, samples: u64 }
#[derive(Default)]
struct Sites { index: HashMap<Vec<usize>, usize>, values: Vec<Site> }
static SITES: LazyLock<Mutex<Sites>> = LazyLock::new(|| Mutex::new(Sites::default()));
static BLOCKS: LazyLock<Vec<Mutex<HashMap<usize, Block>>>> = LazyLock::new(||
    (0..SHARDS).map(|_| Mutex::new(HashMap::new())).collect());

unsafe extern "C" { fn backtrace(buffer: *mut *mut c_void, size: i32) -> i32; fn dladdr(addr: *const c_void, info: *mut DlInfo) -> i32; }
#[repr(C)]
struct DlInfo { file: *const i8, base: *mut c_void, name: *const i8, address: *mut c_void }
fn bypass<T>(f: impl FnOnce() -> T) -> T {
    let old = BUSY.with(|v| v.replace(true));
    struct Reset(bool);
    impl Drop for Reset { fn drop(&mut self) { let _ = BUSY.try_with(|v| v.set(self.0)); } }
    let _reset = Reset(old);
    f()
}
fn tracking() -> bool { ACTIVE.load(Ordering::Relaxed) && !BUSY.try_with(Cell::get).unwrap_or(true) }
fn shard(ptr: *mut u8) -> usize { ((ptr as usize >> 4).wrapping_mul(0x9e3779b97f4a7c15) >> 32) % SHARDS }
fn selected(size: usize) -> bool {
    if size >= INTERVAL { return true; }
    RANDOM.with(|s| {
        let mut x = s.get();
        if x == 0 { x = SEED.fetch_add(1, Ordering::Relaxed).wrapping_mul(0x9e3779b97f4a7c15); }
        x ^= x >> 12; x ^= x << 25; x ^= x >> 27; s.set(x);
        x.wrapping_mul(0x2545f4914f6cdd1d) % (INTERVAL as u64) < size as u64
    })
}
unsafe fn insert(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 || !selected(size) { return; }
    let mut buffer = [std::ptr::null_mut(); DEPTH];
    let n = backtrace(buffer.as_mut_ptr(), DEPTH as i32).max(0) as usize;
    let frames: Vec<usize> = buffer[..n].iter().map(|p| *p as usize).collect();
    let weight = (INTERVAL as f64 / size as f64).max(1.0);
    let bytes = size as f64 * weight;
    let site = {
        let mut sites = SITES.lock().unwrap();
        let id = if let Some(id) = sites.index.get(&frames) { *id } else {
            let id = sites.values.len();
            sites.index.insert(frames.clone(), id);
            sites.values.push(Site { frames, allocated: 0.0, count: 0.0, samples: 0 });
            id
        };
        sites.values[id].allocated += bytes;
        sites.values[id].count += weight;
        sites.values[id].samples += 1;
        id
    };
    BLOCKS[shard(ptr)].lock().unwrap().insert(ptr as usize, Block { site, bytes, count: weight });
}
fn remove(ptr: *mut u8) { BLOCKS[shard(ptr)].lock().unwrap().remove(&(ptr as usize)); }
pub struct Sampled;
#[global_allocator]
static GLOBAL: Sampled = Sampled;
unsafe impl GlobalAlloc for Sampled {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if !tracking() { return mimalloc::MiMalloc.alloc(l); }
        bypass(|| { let _gate = GATE.read().unwrap(); let p = mimalloc::MiMalloc.alloc(l); insert(p, l.size()); p })
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        if !tracking() { return mimalloc::MiMalloc.alloc_zeroed(l); }
        bypass(|| { let _gate = GATE.read().unwrap(); let p = mimalloc::MiMalloc.alloc_zeroed(l); insert(p, l.size()); p })
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        if !tracking() { return mimalloc::MiMalloc.dealloc(p, l); }
        bypass(|| { let _gate = GATE.read().unwrap(); remove(p); mimalloc::MiMalloc.dealloc(p, l); });
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, size: usize) -> *mut u8 {
        if !tracking() { return mimalloc::MiMalloc.realloc(p, l, size); }
        bypass(|| {
            let _gate = GATE.read().unwrap(); let next = mimalloc::MiMalloc.realloc(p, l, size);
            if !next.is_null() { remove(p); insert(next, size); }
            next
        })
    }
}
fn rss() -> u64 {
    fs::read_to_string("/proc/self/status").ok().and_then(|s| s.lines().find(|l| l.starts_with("VmRSS:")).and_then(|l| l.split_whitespace().nth(1)).and_then(|s| s.parse::<u64>().ok())).unwrap_or(0) * 1024
}
pub fn dump(path: &str) -> std::io::Result<()> {
    bypass(|| {
        let _single = DUMP.lock().unwrap();
        let rss_before = rss();
        let (sites, live, blocks) = {
            let _gate = GATE.write().unwrap();
            let sites = SITES.lock().unwrap().values.clone();
            let mut live = vec![(0f64, 0f64, 0u64); sites.len()];
            let mut blocks = 0;
            for shard in BLOCKS.iter() { for b in shard.lock().unwrap().values() {
                live[b.site].0 += b.bytes; live[b.site].1 += b.count; live[b.site].2 += 1; blocks += 1;
            }}
            (sites, live, blocks)
        };
        let mut info = DlInfo { file: std::ptr::null(), base: std::ptr::null_mut(), name: std::ptr::null(), address: std::ptr::null_mut() };
        unsafe { dladdr(dump as *const c_void, &mut info); }
        let base = info.base as usize;
        // Keep only PCs belonging to this binding. Other libraries are not Rust allocator sites.
        let ranges: Vec<(usize, usize)> = fs::read_to_string("/proc/self/maps")?.lines().filter_map(|l| {
            let mut words = l.split_whitespace(); let range = words.next()?; let perm = words.next()?;
            let off = usize::from_str_radix(words.next()?, 16).ok()?;
            let (a, b) = range.split_once('-')?;
            let start = usize::from_str_radix(a, 16).ok()?;
            let end = usize::from_str_radix(b, 16).ok()?;
            // ELF PT_LOAD alignment can introduce one page of offset difference.
            (perm.contains('x') && start >= base && start - base >= off && start - base - off <= 65536).then_some((start, end))
        }).collect();
        let mut out = format!("{{\"samplingInterval\":{INTERVAL},\"rssBeforeSnapshot\":{rss_before},\"sampledLiveBlocks\":{blocks},\"sites\":[");
        for (id, s) in sites.iter().enumerate() {
            if id != 0 { out.push(','); }
            let (bytes, count, samples) = live[id];
            write!(out, "{{\"liveBytes\":{bytes},\"liveCount\":{count},\"liveSamples\":{samples},\"allocatedBytes\":{},\"allocationCount\":{},\"allocationSamples\":{},\"frames\":[", s.allocated, s.count, s.samples).unwrap();
            let mut first = true;
            for pc in &s.frames { if ranges.iter().any(|(a,b)| pc >= a && pc < b) {
                if !first { out.push(','); } first = false;
                write!(out, "\"0x{:x}\"", pc - base - 1).unwrap();
            }}
            out.push_str("]}");
        }
        out.push_str("]}\n");
        let tmp = format!("{path}.tmp"); fs::write(&tmp, out)?; fs::rename(tmp, path)
    })
}
static WORKER: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);
pub fn start(directory: String) {
    bypass(|| {
        STOP.store(false, Ordering::Release);
        // Resolve the unwinder before enabling hooks: its first use can allocate.
        unsafe { let mut p = [std::ptr::null_mut(); DEPTH]; backtrace(p.as_mut_ptr(), DEPTH as i32); }
        LazyLock::force(&BLOCKS); LazyLock::force(&SITES);
        ACTIVE.store(true, Ordering::Release);
        *WORKER.lock().unwrap() = Some(std::thread::spawn(move || bypass(|| {
            let mut high = 0;
            let peak = format!("{directory}/peak-native.json");
            while !STOP.load(Ordering::Acquire) {
                let current = rss();
                if current > high + high / 20 {
                    high = current;
                    if let Err(e) = dump(&peak) { eprintln!("native profile: {e}"); }
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        })));
    });
}
pub fn stop() {
    STOP.store(true, Ordering::Release);
    bypass(|| { if let Some(worker) = WORKER.lock().unwrap().take() { let _ = worker.join(); } });
}
