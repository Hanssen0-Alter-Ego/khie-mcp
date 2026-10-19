import collections
import contextlib
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock
import urllib.request

import audit


def layer(root, entries):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as tar:
        for name, data in entries:
            item = tarfile.TarInfo(name)
            item.size = len(data)
            tar.addfile(item, io.BytesIO(data))
    blob = root / "input.gz"
    blob.write_bytes(gzip.compress(raw.getvalue()))
    return blob, "sha256:" + hashlib.sha256(raw.getvalue()).hexdigest()


class AuditTests(unittest.TestCase):
    def test_deleted_secret_file_remains_scanned(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = root / "first"
            second = root / "second"
            first.mkdir()
            second.mkdir()
            marker = b"-----BEGIN " + b"PRIVATE KEY-----"
            blob, diff_id = layer(first, [("app/secret.key", marker)])
            counts, findings, _ = audit.scan_layer(blob, diff_id, first, {}, False)
            self.assertEqual(findings["private_key_block"], 1)
            self.assertEqual(counts["regular_file_versions"], 1)
            blob, diff_id = layer(second, [("app/.wh.secret.key", b"")])
            counts2, _, _ = audit.scan_layer(blob, diff_id, second, {}, False)
            self.assertEqual(counts2["whiteouts"], 1)
            self.assertEqual(findings["private_key_block"], 1)

    def test_every_duplicate_tar_entry_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            blob, diff_id = layer(root, [("app/a", b"first"), ("app/a", b"last")])
            counts, _, directory = audit.scan_layer(blob, diff_id, root, {}, False)
            self.assertEqual(counts["regular_file_versions"], 2)
            self.assertEqual(len(list(directory.glob("*.data"))), 2)

    def test_digest_failure_precedes_scanning(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            blob, _ = layer(root, [("app/file", b"data")])
            with self.assertRaisesRegex(audit.AuditError, "^diff_id_mismatch$"):
                audit.scan_layer(blob, "sha256:" + "0" * 64, root, {}, False)
            self.assertFalse((root / "files").exists())
        with self.assertRaisesRegex(audit.AuditError, "^digest_mismatch$"):
            audit.verify(b"bad", "sha256:" + "0" * 64)

    def test_manifest_digest_pins_descriptor_changes(self):
        original = json.dumps({"layers": [{"digest": "sha256:" + "a" * 64}]}).encode()
        digest = "sha256:" + hashlib.sha256(original).hexdigest()
        audit.verify(original, digest)
        with self.assertRaisesRegex(audit.AuditError, "^digest_mismatch$"):
            audit.verify(original.replace(b"aaaa", b"bbbb"), digest)

    def test_recompression_keeps_verified_decompressed_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = root / "first"
            second = root / "second"
            first.mkdir()
            second.mkdir()
            blob, diff_id = layer(first, [("app/a", b"public data")])
            data = gzip.decompress(blob.read_bytes())
            other = second / "input.gz"
            other.write_bytes(gzip.compress(data, compresslevel=1, mtime=1))
            self.assertNotEqual(hashlib.sha256(blob.read_bytes()).digest(),
                                hashlib.sha256(other.read_bytes()).digest())
            for source, work in ((blob, first), (other, second)):
                counts, _, _ = audit.scan_layer(source, diff_id, work, {}, True)
                self.assertEqual(counts["regular_file_versions"], 1)

    def test_traversal_is_rejected_without_disclosing_path(self):
        with self.assertRaisesRegex(audit.AuditError, "^unsafe_tar_path$"):
            audit.normal_path("../private-value")
        with self.assertRaises(audit.AuditError):
            audit.normal_path("/absolute")

    def test_provenance_mismatch_is_reported(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            blob, diff_id = layer(root, [("app/packages/khie-mcp/src/demo.ts", b"altered")])
            _, findings, _ = audit.scan_layer(blob, diff_id, root,
                {"app/packages/khie-mcp/src/demo.ts": "0" * 64}, False)
            self.assertEqual(findings["reviewed_source_mismatch"], 1)

    def test_exception_output_is_sanitized(self):
        output = io.StringIO()
        with mock.patch.object(audit, "audit", side_effect=RuntimeError("DO-NOT-EXPOSE")):
            with contextlib.redirect_stdout(output):
                self.assertEqual(audit.main(), 1)
        self.assertNotIn("DO-NOT-EXPOSE", output.getvalue())
        self.assertEqual(json.loads(output.getvalue())["reason"], "sanitized_execution_error")

    def test_cross_origin_redirect_strips_credentials(self):
        request = urllib.request.Request("https://ghcr.io/v2/blob", headers={"Authorization": "fixture"})
        redirect = audit.SafeRedirect().redirect_request(request, None, 307, "", {},
            "https://pkg-containers.githubusercontent.com/blob")
        self.assertIsNone(redirect.get_header("Authorization"))
        with self.assertRaisesRegex(audit.AuditError, "^unexpected_redirect$"):
            audit.SafeRedirect().redirect_request(request, None, 307, "", {}, "https://untrusted.example/blob")

    def test_candidate_classification_never_accepts_unknown_content(self):
        records = {"00000001.data": {"path": "app/source.ts", "sha256": "abc", "metadata": False},
                   "00000002.metadata": {"path": "app/source.ts", "metadata": True}}
        with mock.patch.object(audit, "public_npm_match", return_value=False) as npm:
            counts = audit.classify_flags(set(records), records, Path("unused"), Path("unused"),
                                         {"app/source.ts": "abc"}, False, {}, {})
        self.assertEqual(counts["exact_reviewed_public_source"], 1)
        self.assertEqual(counts["unresolved"], 1)
        npm.assert_not_called()

    def test_unknown_package_never_reaches_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package_root = "app/node_modules/.pnpm/private@1.0.0/node_modules/private"
            (root / "00000000.data").write_text(json.dumps({"name": "private", "version": "1.0.0"}))
            record = {"path": package_root + "/index.js", "sha256": "abc", "metadata": False}
            records = {"00000000.data": {"path": package_root + "/package.json", "metadata": False}}
            with mock.patch.object(audit, "get_json") as request:
                self.assertFalse(audit.public_npm_match(record, records, root, root, {}, {}))
                request.assert_not_called()

    def test_public_npm_candidate_requires_matching_file_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package_root = "app/node_modules/.pnpm/example@1.0.0/node_modules/example"
            (root / "00000000.data").write_text(json.dumps({"name": "example", "version": "1.0.0"}))
            record = {"path": package_root + "/index.js", "sha256": "actual", "metadata": False}
            records = {"00000000.data": {"path": package_root + "/package.json", "metadata": False}}
            self.assertFalse(audit.public_npm_match(record, records, root, root,
                {"example@1.0.0": "sha512-fixture"}, {"example@1.0.0": {"index.js": "different"}}))

    def test_generated_candidate_requires_bundle_source_and_value_proof(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = 'export const sample = "harmless-public-fixture";\n'
            compiled = b'const sample="harmless-public-fixture";'
            path = "app/packages/core/dist/index.js"
            (root / "00000001.data").write_bytes(compiled)
            (root / "00000002.data").write_text(json.dumps({"sourcesContent": [original]}))
            record = {"path": path, "sha256": audit.sha(compiled), "metadata": False}
            records = {"00000001.data": record, "00000002.data":
                       {"path": path + ".map", "metadata": False}}
            sources = {"app/packages/core/src/index.ts": audit.sha(original.encode())}
            generated = {path: audit.sha(compiled)}
            output = io.StringIO()
            with mock.patch.object(audit, "gitleaks", return_value=(collections.Counter(),
                    [{"Secret": "harmless-public-fixture"}])):
                with contextlib.redirect_stdout(output):
                    result = audit.generated_public_match(record, "00000001.data", records,
                        root, root, sources, generated, {}, Path("scanner"))
                self.assertTrue(result[0])
            self.assertEqual(output.getvalue(), "")
            with mock.patch.object(audit, "gitleaks", return_value=(collections.Counter(),
                    [{"Secret": "different-private-fixture"}])):
                result = audit.generated_public_match(record, "00000001.data", records,
                    root, root, sources, generated, {}, Path("scanner"))
                self.assertFalse(result[0])
                self.assertEqual(result[1], "candidate_not_present_in_verified_public_source")
            result = audit.generated_public_match(record, "00000001.data", records,
                root, root, sources, {path: "wrong"}, {}, Path("scanner"))
            self.assertEqual(result, (False, "not_exact_retained_bundle"))
            result = audit.generated_public_match(record, "00000001.data", records,
                root, root, {}, generated, {}, Path("scanner"))
            self.assertEqual(result, (False, "source_map_inputs_not_all_verified"))

    def test_public_alias_uses_locked_canonical_tarball_and_exact_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package_root = "app/node_modules/.pnpm/@public+alias@1.0.0/node_modules/alias"
            (root / "00000000.data").write_text(json.dumps({"name": "original-name", "version": "1.0.0"}))
            record = {"path": package_root + "/index.js", "sha256": "exact", "metadata": False}
            records = {"00000000.data": {"path": package_root + "/package.json", "metadata": False}}
            allowed = {"@public/alias@1.0.0": "sha512-fixture"}
            cache = {"@public/alias@1.0.0": {"index.js": "exact"}}
            with mock.patch.object(audit, "get_json") as request:
                self.assertTrue(audit.public_npm_match(record, records, root, root, allowed, cache))
                request.assert_not_called()
                record["sha256"] = "different"
                self.assertFalse(audit.public_npm_match(record, records, root, root, allowed, cache))


if __name__ == "__main__":
    unittest.main()
