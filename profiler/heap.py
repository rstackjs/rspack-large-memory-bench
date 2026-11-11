"""Aggregate V8 shallow sizes without loading source strings or the edge graph."""
import json
import mmap
from pathlib import Path
import re
import sys
from collections import defaultdict


def analyze(file):
    with open(file, 'rb') as source, mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as data:
        marker = re.search(rb'"nodes"\s*:\s*\[', data)
        if not marker:
            raise ValueError('Missing V8 nodes array')
        header = json.loads(data[:marker.start()].rstrip().rstrip(b',') + b'}')['snapshot']
        fields = header['meta']['node_fields']
        types = header['meta']['node_types'][fields.index('type')]
        indexes = {k: fields.index(k) for k in ('type', 'name', 'self_size')}
        groups = defaultdict(lambda: [0, 0])
        named = {'object', 'closure', 'native', 'synthetic', 'code', 'array', 'object shape', 'hidden'}
        row = []
        node_count = total = 0
        for match in re.compile(rb'\d+').finditer(data, marker.end(), data.find(b']', marker.end())):
            row.append(int(match[0]))
            if len(row) == len(fields):
                kind = types[row[indexes['type']]]
                name = row[indexes['name']] if kind in named else -1
                size = row[indexes['self_size']]
                group = groups[kind, name]
                group[0] += size
                group[1] += 1
                node_count += 1
                total += size
                row = []
        if row or node_count != header['node_count']:
            raise ValueError('Incomplete nodes array')
        needed = {name for kind, name in groups if name >= 0}
        marker = re.search(rb'"strings"\s*:\s*\[', data)
        if not marker:
            raise ValueError('Missing V8 strings table')
        pos, index, names = marker.end(), 0, {}
        while pos < len(data):
            while data[pos] in b' \n\r\t,':
                pos += 1
            if data[pos] == ord(']'):
                break
            if data[pos] != ord('"'):
                raise ValueError('Invalid string table')
            end = pos + 1
            while True:
                end = data.find(b'"', end)
                if end < 0:
                    raise ValueError('Unterminated string')
                back = end - 1
                while data[back] == ord('\\'):
                    back -= 1
                if (end - 1 - back) % 2 == 0:
                    break
                end += 1
            if index in needed:
                names[index] = json.loads(data[pos:end + 1])
            index += 1
            pos = end + 1
        merged = defaultdict(lambda: [0, 0])
        for (kind, name), (size, count) in groups.items():
            label = (names[name] or '(unnamed)') if name >= 0 else '(primitive values)'
            merged[kind, label][0] += size
            merged[kind, label][1] += count
        rows = [{'type': kind, 'name': name, 'bytes': size, 'count': count}
                for (kind, name), (size, count) in merged.items()]
        return {'nodeCount': node_count, 'totalSelfBytes': total,
                'groups': sorted(rows, key=lambda r: -r['bytes'])}


if __name__ == '__main__':
    Path(sys.argv[2]).write_text(json.dumps(analyze(sys.argv[1]), ensure_ascii=False) + '\n')
