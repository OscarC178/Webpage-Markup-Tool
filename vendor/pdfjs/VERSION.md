# pdf.js (bundled, pinned)

- Package: `pdfjs-dist` from npm (Mozilla's official build), https://www.npmjs.com/package/pdfjs-dist
- Version: **6.5.438**, published 2026-11-01. Do not update without re-running the PDF checks.
- Licence: Apache-2.0 (`LICENSE` in this folder). The image decoders' licences are in `wasm/LICENSE_*`.
- Nothing is loaded from the network. The viewer turns off `eval` (`isEvalSupported: false`), XFA forms and PDF JavaScript.

Files taken from the package: `build/pdf.min.mjs`, `build/pdf.worker.min.mjs`,
`web/pdf_viewer.mjs`, `web/pdf_viewer.css`, one image in `web/images/`,
`cmaps/`, `standard_fonts/`, `wasm/` (JPEG 2000, JBIG2 and colour-profile
decoders; not the QuickJS scripting engine), `iccs/`.

SHA-256 of the main files, to check the bundle has not been changed:

```
3a88402882cfa3e7e72c2c9b5149f52f0f88baf1c5b62aa11a41abdbc2072440  build/pdf.min.mjs
1e64c8240e54735ec5913b37acd5134747799cb8c6bb3777c70adbc01232d2aa  build/pdf.worker.min.mjs
3b9c62a10b271b64d7e508adefa3ca1b03ac5887ddceb755293e7a8f6dfc2cac  web/pdf_viewer.mjs
d341eac2069f7f3c1f68d1edc297b665fd8a0e2a593e145b85200729823df2a2  web/pdf_viewer.css
```
