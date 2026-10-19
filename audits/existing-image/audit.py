"""Read-only audit of one existing OCI image. Never execute image code.

Only stage names, public digests and aggregate counts may reach stdout. Raw
image bytes, paths, reports and subprocess output remain in a private temporary
directory, are never uploaded, and are removed on every normal exit. Denials
stop the job: no retries, credential generation or permission changes.
"""
import base64
import collections
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request

REPO = "Hanssen0-Alter-Ego/khie-mcp"
PACKAGE = "hanssen0-alter-ego/khie-mcp-reconnect"
DIGEST = "sha256:d4015ee3dae12b7a67674d7bcdb583d317903e4fd1d87a379356bc996761ba85"
CONFIG = "sha256:884f6eeb402edb692a730e03668faa8c2d38f4dc95db0be7e09ac0d2204d9d8c"
LAYERS = """dbaa5c62f0ed2acebf15ba5fc565cb938c8495c0b77e1acfab05f5a7354ab1a9
990581063f5c8a03a57db7a0d116679ea6e6e335d4ac48ef457f26f82d917eba
f95897c2a1fb7bce26b018dd74b2845f816f7b86d5adff2939c6482b1d5b474c
c35748eaa5ecc949b0f7cc349a9f7c4a5417dc008e2d9bebd53678d87238fcbf
4996e33358abd29e5daf56cdda6681efb4db3bd55b5ab63a7d3d44f8400195a4
486d1b897da1811bbd71778f81670acca8bc317e380c8a43cf963c675cf0e7d0
957340e0d7c2791d93d13f96e9ba1a4bf7287dbb52c4a24c58d77df3811e0ad5
f7c27c9882f00107e1215887f64281ed6ac8e8886350444bfe2222e6979d920b
89b1c5f5da5d1bf2c2bc03b234e9435ff853f8580cad225d07715b46195827dc
808fc52295b6ec4ac3f9fdec46e9cfb8fdcea38a8b29f88133e572a02db1ace7""".split()
CODE_COMMIT = "2ebb4258cf679e62530437802ede058693f5294c"
GUIDE_COMMIT = "a13904cc1c90f43dd7058123ca773e54c3c15b06"
BASE_INDEX = "sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df"
GITLEAKS_SHA = "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
GITLEAKS_URL = "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz"
MAX_BLOB = 2 * 1024**3
MAX_LAYER = 4 * 1024**3
MAX_FILE = 512 * 1024**2


class AuditError(Exception):
    """Only fixed, non-content-derived error codes are safe to publish."""


def need(condition, code):
    if not condition:
        raise AuditError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def verify(data, digest):
    need("sha256:" + sha(data) == digest, "digest_mismatch")


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        allowed = ("github.com", "ghcr.io", "raw.githubusercontent.com",
                   "pkg-containers.githubusercontent.com", "release-assets.githubusercontent.com",
                   "registry-1.docker.io", "production.cloudflare.docker.com")
        need(target.scheme == "https" and target.hostname in allowed,
             "unexpected_redirect")
        result = super().redirect_request(req, fp, code, msg, headers, newurl)
        if target.netloc != urllib.parse.urlsplit(req.full_url).netloc:
            for name in ("Authorization", "Cookie", "Proxy-authorization"):
                result.remove_header(name)
        return result


HTTP = urllib.request.build_opener(SafeRedirect())


def fetch(url, headers=None, destination=None, limit=1024**2, digest=None):
    # Auth is attached only by the caller to the intended origin. No cookies,
    # .netrc, ambient Git config or shell credential helpers are consulted.
    request = urllib.request.Request(url, headers=headers or {})
    with HTTP.open(request, timeout=90) as response:
        h = hashlib.sha256()
        size = 0
        sink = destination.open("wb") if destination else io.BytesIO()
        try:
            while chunk := response.read(1024**2):
                size += len(chunk)
                need(size <= limit, "download_limit")
                h.update(chunk)
                sink.write(chunk)
            if digest:
                need("sha256:" + h.hexdigest() == digest, "digest_mismatch")
            return size if destination else sink.getvalue()
        finally:
            sink.close()


def get_json(url, headers=None, digest=None):
    return json.loads(fetch(url, headers, digest=digest))


def access_preflight(token):
    # This read is credential-free even though the process has a job token.
    guide = fetch(f"https://raw.githubusercontent.com/{REPO}/{GUIDE_COMMIT}/RECONNECT_PROTOTYPE.md")
    need(DIGEST.encode() in guide, "anonymous_repository_read_failed")
    auth = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28"}
    endpoint = "https://api.github.com/users/Hanssen0-Alter-Ego/packages/container/khie-mcp-reconnect"
    package = get_json(endpoint, auth)
    need(package.get("name") == "khie-mcp-reconnect", "wrong_package")
    need(package.get("repository", {}).get("full_name") == REPO, "wrong_package_repository")
    need(package.get("visibility") == "private", "package_visibility_changed")
    versions = get_json(endpoint + "/versions?state=active&per_page=100", auth)
    need(len(versions) == 1, "package_version_scope_changed")
    v = versions[0]
    need(v.get("id") == 1407464180 and v.get("name") == DIGEST, "package_version_changed")
    need(v.get("metadata", {}).get("container", {}).get("tags") == ["sha-" + CODE_COMMIT],
         "package_tag_changed")
    basic = base64.b64encode(("Hanssen0-Alter-Ego:" + token).encode()).decode()
    url = "https://ghcr.io/token?" + urllib.parse.urlencode({
        "service": "ghcr.io", "scope": "repository:" + PACKAGE + ":pull"})
    access = get_json(url, {"Authorization": "Basic " + basic})
    registry_token = access.get("token") or access.get("access_token")
    need(isinstance(registry_token, str) and registry_token, "registry_access_denied")
    return {"Authorization": "Bearer " + registry_token}, {
        "anonymous_repository_read": "passed", "existing_package_access": "passed",
        "active_versions": 1, "untagged_versions": 0, "package_visibility": "private"}


def public_base_layers():
    access = get_json("https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull")
    headers = {"Authorization": "Bearer " + access["token"],
               "Accept": "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"}
    root = "https://registry-1.docker.io/v2/library/node/manifests/"
    index = get_json(root + BASE_INDEX, headers, BASE_INDEX)
    choices = [x for x in index["manifests"] if x.get("platform", {}).get("os") == "linux"
               and x.get("platform", {}).get("architecture") == "amd64"]
    need(len(choices) == 1, "base_platform_ambiguous")
    manifest = get_json(root + choices[0]["digest"], headers, choices[0]["digest"])
    # These retained bytes came from the existing official Node image, never a
    # rebuild. The public pinned manifest must confirm their exact config hash.
    # Avoid adding new CDN origins merely to fetch the same public config.
    base_config_raw = Path(__file__).with_name("public-node-base-config.json").read_bytes()
    verify(base_config_raw, manifest["config"]["digest"])
    base_config = json.loads(base_config_raw)
    return [x["digest"] for x in manifest["layers"]], base_config["rootfs"]["diff_ids"]


RULES = {
    "private_key_block": rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----",
    "credential_token": rb"(?:gh[pousr]_[A-Za-z0-9_]{24,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,})",
    "wallet_seed_literal": rb"(?i)[\"'](?:mnemonic|seedPhrase|seed_phrase)[\"']\s*:\s*[\"'][a-z]+(?: [a-z]+){11,23}[\"']",
    "wallet_private_key_literal": rb"(?i)[\"'](?:privateKey|private_key|communicationPrivateKey)[\"']\s*:\s*[\"'](?:0x)?[a-f0-9]{64,}[\"']",
}
COMPILED = {k: re.compile(v) for k, v in RULES.items()}


def scan_bytes(data, findings):
    for rule, pattern in COMPILED.items():
        if pattern.search(data):
            findings[rule] += 1


def normal_path(name):
    path = PurePosixPath(name)
    need(not path.is_absolute() and ".." not in path.parts, "unsafe_tar_path")
    return str(path)


def scan_layer(blob, diff_id, scratch, source_hashes, is_base):
    # Inspect the complete original tar in order. Whiteouts are counted rather
    # than applied: data deleted by a later layer must still be inspected.
    raw = scratch / "layer.tar"
    h = hashlib.sha256()
    total = 0
    with blob.open("rb") as f:
        magic = f.read(2)
    opener = gzip.open if magic == b"\x1f\x8b" else open
    with opener(blob, "rb") as src, raw.open("wb") as out:
        while chunk := src.read(1024**2):
            total += len(chunk)
            need(total <= MAX_LAYER, "expanded_layer_limit")
            h.update(chunk)
            out.write(chunk)
    need("sha256:" + h.hexdigest() == diff_id, "diff_id_mismatch")
    files = scratch / "files"
    files.mkdir()
    counts = collections.Counter()
    findings = collections.Counter()
    with tarfile.open(raw, "r:") as archive:
        for i, member in enumerate(archive):
            name = normal_path(member.name)
            counts["entries"] += 1
            # Metadata itself can contain credentials; include it in the scan.
            metadata = json.dumps({"name": member.name, "link": member.linkname,
                                   "pax": member.pax_headers}).encode()
            scan_bytes(metadata, findings)
            (files / f"{i:08d}.metadata").write_bytes(metadata)
            if PurePosixPath(name).name.startswith(".wh."):
                counts["whiteouts"] += 1
            if not member.isfile():
                need(member.isdir() or member.issym() or member.islnk(), "unexpected_tar_type")
                counts["links" if member.issym() or member.islnk() else "directories"] += 1
                continue
            need(member.size <= MAX_FILE, "file_size_limit")
            counts["regular_file_versions"] += 1
            counts["regular_bytes"] += member.size
            # Flatten names: never follow layer symlinks/hardlinks, never let a
            # path or .gitleaks.toml inside the image control scanner behavior.
            content_hash = hashlib.sha256()
            overlap = b""
            with archive.extractfile(member) as src, (files / f"{i:08d}.data").open("wb") as out:
                while chunk := src.read(1024**2):
                    out.write(chunk)
                    content_hash.update(chunk)
                    scan_bytes(overlap + chunk, findings)
                    overlap = chunk[-8192:]
            if name in source_hashes:
                counts["reviewed_source_files"] += 1
                if content_hash.hexdigest() != source_hashes[name]:
                    findings["reviewed_source_mismatch"] += 1
            if not is_base:
                if not name.startswith("app/"):
                    findings["unexpected_non_app_file"] += 1
                elif re.search(r"(?:^|/)(?:\.git|\.aws|\.ssh|\.docker)(?:/|$)|(?:^|/)(?:\.env(?:\..*)?|http-token|store-key|client\.json|credentials|id_rsa|id_ed25519)$", name):
                    findings["sensitive_file_path"] += 1
                elif name not in source_hashes and not allowed_generated(name):
                    findings["unclassified_application_file"] += 1
    return counts, findings, files


def allowed_generated(name):
    return (name.startswith("app/node_modules/")
            or re.match(r"app/packages/(?:core|libp2p|khie-mcp)/(?:dist(?:\.commonjs)?|node_modules)/", name)
            or name in {"app/container/entrypoint.sh", "app/provenance/LICENSE",
                        "app/provenance/NOTICE.md", "app/provenance/UPSTREAM.json"})


def install_scanner(scratch):
    archive = scratch / "scanner.tar.gz"
    fetch(GITLEAKS_URL, destination=archive, limit=16 * 1024**2, digest="sha256:" + GITLEAKS_SHA)
    binary = scratch / "gitleaks"
    with tarfile.open(archive, "r:gz") as t:
        member = t.getmember("gitleaks")
        need(member.isfile() and member.size < 64 * 1024**2, "scanner_archive_invalid")
        binary.write_bytes(t.extractfile(member).read())
    binary.chmod(0o700)
    return binary


def gitleaks(binary, directory, scratch):
    report = scratch / "gitleaks-report.json"
    # No image-supplied baseline/ignore configuration. The scanner receives no
    # job token, registry bearer token, Docker config, proxy auth or Git config.
    config = scratch / "gitleaks.toml"
    config.write_text('[extend]\nuseDefault = true\n')
    result = subprocess.run([
        str(binary), "dir", str(directory), "--config", str(config),
        "--gitleaks-ignore-path", str(scratch / "no-ignore-file"),
        "--ignore-gitleaks-allow", "--redact=100", "--no-banner", "--no-color",
        "--log-level", "error", "--max-decode-depth", "4", "--max-archive-depth", "4",
        "--report-format", "json", "--report-path", str(report), "--timeout", "900",
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=960, cwd=scratch,
        env={"PATH": os.defpath, "HOME": str(scratch)})
    need(result.returncode in (0, 1), "scanner_execution_failed")
    items = json.loads(report.read_text()) if report.exists() else []
    need(result.returncode == 0 or items, "scanner_failure_without_report")
    # Rule IDs/counts only. Never print descriptions, match text, paths or secret
    # fingerprints from the image-derived Gitleaks report.
    counts = collections.Counter()
    for item in items:
        key = item.get("RuleID", "")
        need(bool(re.fullmatch(r"[a-z0-9-]{1,80}", key)), "invalid_scanner_report")
        counts["gitleaks:" + key] += 1
    return counts


def audit(scratch, progress):
    progress["stage"] = "verify_existing_access"
    token = os.environ.get("GH_TOKEN", "")
    need(bool(token), "missing_existing_job_token")
    auth, access = access_preflight(token)
    progress.update(access)
    print(json.dumps({"stage": "preflight_passed", **access}), flush=True)
    progress["stage"] = "verify_manifest_and_config"
    accept = {**auth, "Accept": "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"}
    root = "https://ghcr.io/v2/" + PACKAGE
    manifest_raw = fetch(root + "/manifests/" + DIGEST, accept, digest=DIGEST)
    manifest = json.loads(manifest_raw)
    need(manifest.get("schemaVersion") == 2, "manifest_schema")
    need(manifest["config"]["digest"] == CONFIG and manifest["config"]["size"] == 9917,
         "config_descriptor_changed")
    layers = manifest["layers"]
    # The root digest pins the exact authoritative descriptor list. Browser UI
    # blob lists can include config/auxiliary objects and use a different order;
    # their transcription must not replace this cryptographic boundary.
    need(0 < len(layers) <= 32, "layer_count_limit")
    need(all(re.fullmatch(r"sha256:[a-f0-9]{64}", x["digest"])
             and 0 <= x["size"] <= MAX_BLOB for x in layers), "invalid_layer_descriptor")
    progress.update({"manifest_layer_count": len(layers),
                     "browser_list_matches_manifest_set":
                     {x["digest"] for x in layers} == {"sha256:" + x for x in LAYERS}})
    config_raw = fetch(root + "/blobs/" + CONFIG, auth, digest=CONFIG)
    need(len(config_raw) == 9917, "config_size_changed")
    config = json.loads(config_raw)
    need(config.get("architecture") == "amd64" and config.get("os") == "linux", "platform_changed")
    need(config["config"].get("Labels", {}).get("org.opencontainers.image.revision") == CODE_COMMIT,
         "image_revision_changed")
    need(config["config"].get("User") == "1000:1000", "image_user_changed")
    diff_ids = config["rootfs"]["diff_ids"]
    need(len(diff_ids) == len(layers), "diff_id_count")
    env_names = {x.split("=", 1)[0] for x in config["config"].get("Env", [])}
    need(env_names <= {"PATH", "NODE_VERSION", "YARN_VERSION", "NODE_ENV", "KHIE_CONFIG_FILE"},
         "unexpected_image_environment")
    base, base_diff_ids = public_base_layers()
    # Registry exports may recompress an inherited layer. The verified public
    # base config's diff IDs pin its exact decompressed tar bytes; every target
    # layer is independently decompressed and checked against these below.
    need(len(base) == len(base_diff_ids) and diff_ids[:len(base)] == base_diff_ids,
         "public_base_content_mismatch")
    progress.update({"manifest_sha256_verified": True, "config_sha256_verified": True,
                     "public_base_layers": len(base), "layers_expected": len(layers),
                     "base_compressed_digests_match": [x["digest"] for x in layers[:len(base)]] == base,
                     "public_base_diff_ids_match": True})
    progress["stage"] = "install_pinned_scanner"
    binary = install_scanner(scratch)
    findings = collections.Counter()
    totals = collections.Counter()
    config_dir = scratch / "config-input"
    config_dir.mkdir()
    (config_dir / "config.data").write_bytes(config_raw)
    scan_bytes(config_raw, findings)
    findings.update(gitleaks(binary, config_dir, scratch))
    source_hashes = json.loads(Path(__file__).with_name("source-sha256.json").read_text())
    for i, (layer, diff_id) in enumerate(zip(layers, diff_ids)):
        progress["stage"] = "audit_layer"
        progress["layer_number"] = i + 1
        need(layer["mediaType"] in ("application/vnd.oci.image.layer.v1.tar+gzip",
             "application/vnd.docker.image.rootfs.diff.tar.gzip", "application/vnd.oci.image.layer.v1.tar"),
             "unsupported_layer_encoding")
        with tempfile.TemporaryDirectory(dir=scratch) as temporary:
            work = Path(temporary)
            blob = work / "blob"
            size = fetch(root + "/blobs/" + layer["digest"], auth, blob, MAX_BLOB, layer["digest"])
            need(size == layer["size"], "layer_size_mismatch")
            counts, flags, files = scan_layer(blob, diff_id, work, source_hashes, i < len(base))
            flags.update(gitleaks(binary, files, work))
            findings.update(flags)
            totals.update(counts)
            progress["layers_verified_and_scanned"] = i + 1
            print(json.dumps({"layer": i + 1, "compressed_digest_verified": True,
                              "diff_id_verified": True, "counts": dict(counts),
                              "findings": dict(flags)}), flush=True)
    progress.update({"stage": "complete", "image_digest": DIGEST,
                     "scanner": "gitleaks 8.30.1 plus wallet/path/provenance checks",
                     "counts": dict(totals), "findings": dict(findings),
                     "image_executed": False, "rebuild": False, "republish": False,
                     "artifact_uploads": False,
                     "result": "needs_review" if findings else "no_findings"})
    return 2 if findings else 0


def main():
    os.umask(0o077)
    progress = {"stage": "start", "image_digest": DIGEST}
    code = 1
    try:
        with tempfile.TemporaryDirectory(prefix="khie-image-audit-") as directory:
            code = audit(Path(directory), progress)
    except urllib.error.HTTPError as error:
        progress.update({"result": "blocked", "reason": "http_access_failed", "http_status": error.code})
    except AuditError as error:
        progress.update({"result": "blocked", "reason": str(error)})
    except Exception:
        # Exception text, filenames and tracebacks can contain image content or
        # redirect credentials. Do not print them in a public workflow.
        progress.update({"result": "blocked", "reason": "sanitized_execution_error"})
    print(json.dumps(progress, sort_keys=True), flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
