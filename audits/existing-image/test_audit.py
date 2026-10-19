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


if __name__ == "__main__":
    unittest.main()
