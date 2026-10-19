# Existing-image exposure audit

This read-only workflow audits only the previously published Khie image digest
`sha256:d4015ee3dae12b7a67674d7bcdb583d317903e4fd1d87a379356bc996761ba85`.
It cannot build, publish, delete, change visibility, or execute the image. It uses
the repository's existing ephemeral job token with `contents: read` and
`packages: read`, without adding credentials or changing persistent grants.

The initial audit verified the public guide without authentication in run
39210247569; this continuation does not repeat that check. Before image access
it checks the existing package's private visibility and repository association, and its one active
version/tag. A denial stops execution. Manifest/config/compressed-layer hashes,
sizes, and decompressed diff IDs are checked. The pinned public Node base is
identified independently. Every layer is inspected separately; whiteouts do not
remove earlier versions from scanning. Image paths and links are never extracted
as filesystem paths, and image-supplied scanner configuration is not honored.
The root manifest's verified digest is authoritative for the descriptor list;
browser UI blob-list transcription is recorded only as a consistency observation.
The public Node base config is retained from the existing official image and
must hash to the config descriptor in the independently fetched pinned public
manifest. Its diff IDs verify exact base tar bytes despite recompression. No
base or application image is rebuilt as evidence.

Gitleaks 8.30.1 is pinned by the upstream release archive's SHA-256. It runs with
no job/registry credentials, with decoding and archive traversal depth four.
Supplemental byte scans cover key blocks, credential tokens and wallet fields;
path checks flag state/credential locations, unknown application files and
changes outside `/app`. Source hashes cover the already reviewed public CCC
workspace and bridge source. Candidate matches are resolved only when the
complete file is byte-identical to reviewed public source or a public npm file
whose tarball passes the already-public lockfile's SHA-512 integrity check, or
when it belongs to the byte-verified public base. Unknown package identities
are never sent to a registry. Structural/provenance findings are never waived.
Public npm aliases are resolved from canonical pnpm directory identities only
when those identities exist in the already-public lockfile. A different embedded
package name does not establish provenance; the locked tarball integrity and
complete candidate file hash must still match exactly.
For generated bundles, resolution additionally requires the exact hash of a
retained build artifact (no rebuild), verified public source-map inputs, and
proof that every detected value occurs in those exact public inputs. Detector
values used for that comparison stay inside the private process and temporary
report; they are never logged, uploaded or returned to a caller. A failure of
any comparison remains unresolved. Only fixed classifications and opaque
sequential candidate IDs are reported.
Dependency/build outputs are secret-scanned but are not claimed to be
reproducibly rebuilt or completely compared with every upstream npm tarball.
This is an exposure audit, not a vulnerability assessment
or a proof that every possible encoded secret can be detected.

Only fixed stage names, known public digests, aggregate counts and scanner rule
IDs are logged. Image bytes, paths, matches, subprocess output and detailed
reports remain in a private temporary directory and are removed on exit. No
artifact is uploaded. Any unresolved candidate or structural/provenance finding
returns `needs_review`; no match text is published. Exact public-file matches
are reported as aggregate provenance counts, without names or match text.
A scanner, format, digest, size or access failure returns `blocked`.
Neither outcome authorizes changing image visibility.

The public source hash manifest was derived from the previously verified exact
CCC workspace at `0abf78e5f469216e82a24de8d4051e757368af90` plus the audited
prototype patch, and from the committed container/provenance files. No image
contents or runtime state are part of this audit's source files.
The retained generated-file manifest contains hashes only. Its source, build
configuration and lockfile inputs matched 211 audited files. Three bridge
Markdown documentation files differ; they are outside the TypeScript compiler
inputs. No generated artifact or image was rebuilt for this comparison.

Local synthetic tests:

```sh
python3 -m unittest discover -s audits/existing-image -p 'test_*.py'
```
