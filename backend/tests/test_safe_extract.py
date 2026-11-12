import io, stat, tempfile, unittest, zipfile
from pathlib import Path
from ml.safe_extract import UnsafeArchive, safe_extract

def make_zip(path, entries, symlink=None):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries.items(): zf.writestr(name, data)
        if symlink:
            info = zipfile.ZipInfo(symlink[0]); info.external_attr = (stat.S_IFLNK | 0o777) << 16; zf.writestr(info, symlink[1])

class SafeExtractTests(unittest.TestCase):
    def setUp(self): self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
    def tearDown(self): self.tmp.cleanup()
    def zip(self, entries, **kw):
        p = self.root / 'a.zip'; make_zip(p, entries, **kw); return p

    def test_extracts_allowed_files_flattened(self):
        z = self.zip({'data/train.csv': 'a,b\n1,2\n', 'README.md': 'hi'})
        out = safe_extract(z, self.root / 'out')
        self.assertEqual({f['name'] for f in out['files']}, {'data__train.csv', 'README.md'})
        self.assertTrue((self.root / 'out' / 'data__train.csv').exists())

    def test_rejects_path_traversal_without_writing_anything(self):
        z = self.zip({'../evil.csv': 'x'})
        with self.assertRaises(UnsafeArchive): safe_extract(z, self.root / 'out')
        self.assertFalse((self.root / 'out').exists()); self.assertFalse((self.root.parent / 'evil.csv').exists())

    def test_rejects_absolute_and_windows_paths(self):
        for name in ('/etc/x.csv', 'C:/x.csv', 'a\\b.csv'):
            with self.assertRaises(UnsafeArchive, msg=name): safe_extract(self.zip({name: 'x'}), self.root / ('o' + str(abs(hash(name)))))

    def test_rejects_symlinks(self):
        with self.assertRaises(UnsafeArchive): safe_extract(self.zip({'ok.csv': 'a'}, symlink=('link.csv', '/etc/passwd')), self.root / 'out')

    def test_rejects_disallowed_types(self):
        for name in ('run.sh', 'model.pkl', 'x.py', 'noext', 'a.exe'):
            with self.assertRaises(UnsafeArchive, msg=name): safe_extract(self.zip({name: 'x'}), self.root / ('o' + name))

    def test_rejects_zip_bomb_ratio_and_size(self):
        with self.assertRaises(UnsafeArchive): safe_extract(self.zip({'big.csv': 'a' * 5_000_000}), self.root / 'o1')
        with self.assertRaises(UnsafeArchive): safe_extract(self.zip({'a.csv': 'x,y\n1,2\n' * 10}), self.root / 'o2', max_total_bytes=10)

    def test_rejects_too_many_files_and_collisions(self):
        with self.assertRaises(UnsafeArchive): safe_extract(self.zip({f'f{i}.csv': str(i) for i in range(5)}), self.root / 'o1', max_files=3)
        with self.assertRaises(UnsafeArchive): safe_extract(self.zip({'a/b.csv': '1', 'a__b.csv': '2'}), self.root / 'o2')

    def test_never_overwrites_existing_destination(self):
        (self.root / 'out').mkdir(); (self.root / 'out' / 'keep.csv').write_text('precious')
        with self.assertRaises(FileExistsError): safe_extract(self.zip({'a.csv': '1'}), self.root / 'out')
        self.assertEqual((self.root / 'out' / 'keep.csv').read_text(), 'precious')

    def test_not_a_zip(self):
        p = self.root / 'bad.zip'; p.write_bytes(b'not a zip')
        with self.assertRaises(UnsafeArchive): safe_extract(p, self.root / 'out')

if __name__ == '__main__': unittest.main()
