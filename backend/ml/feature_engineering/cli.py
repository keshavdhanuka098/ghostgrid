"""Command line feature extraction: reads a scenario/graph JSON (file or stdin) and prints features as JSON.

    python -m ml.feature_engineering.cli --input scenario.json
    cat scenario.json | python -m ml.feature_engineering.cli
"""
import argparse, json, sys
from .topology import extract_graph_features


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--input', '-i', help='JSON file with "assets" and "dependencies" (default: stdin)')
    ap.add_argument('--flat', action='store_true', help='print only the graph-level feature vector')
    args = ap.parse_args(argv)
    try:
        raw = open(args.input, encoding='utf-8').read() if args.input else sys.stdin.read()
        doc = json.loads(raw)
        graph = doc.get('graph', doc) if isinstance(doc, dict) else None
        if not isinstance(graph, dict):
            raise ValueError('input must be a JSON object with assets and dependencies')
        out = extract_graph_features(graph)
    except (OSError, ValueError) as err:
        print(json.dumps({'error': str(err)}), file=sys.stderr)
        return 2
    print(json.dumps(out['graph'] if args.flat else out, indent=None if not sys.stdout.isatty() else 2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
