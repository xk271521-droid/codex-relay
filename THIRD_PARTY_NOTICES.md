# Third-Party Notices

Codex Relay is an independent project. It does not bundle the referenced
applications as runtime dependencies. Adapted source and design techniques are
listed below.

## Codex Dream Skin

The theme injector's native-control reconciliation, idempotent runtime model,
and image-layer styling approach are adapted from
[Fei-Away/Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin),
copyright (c) 2026 Codex Dream Skin Studio contributors, licensed under MIT.

Relay keeps its own DevTools Pipe lifecycle, independent theme state, restore
flow, and ENFP-specific styling. The upstream gallery images are concept
screenshots rather than importable wallpapers. Character, likeness, trademark,
and user-supplied image rights are not granted by the MIT software license and
must be reviewed separately before redistribution or commercial use.

## ws

Responses WebSocket client and server transport uses
[websockets/ws](https://github.com/websockets/ws), copyright (c) 2011 Einar Otto
Stangvik, licensed under MIT.

## CodexBridge

Selected request-body compatibility techniques in `src/request-body.js` are
adapted from the `src/json.js` approach in
[wangzhezbz/codex-bridge](https://github.com/wangzhezbz/codex-bridge),
copyright (c) 2026 wangzhezbz, licensed under MIT.

The provider routing, UI, persistence, and configuration lifecycle in this
project are independently implemented.

## CC Switch

The session-visibility safety model and the backup-first provider-bucket
migration in `src/session-history.js` are adapted from the published design and
source implementation of
[farion1231/cc-switch](https://github.com/farion1231/cc-switch),
copyright (c) 2025 Jason Young, licensed under MIT.

Codex Relay remains an independent application and does not bundle CC Switch as
a runtime dependency or copy its user interface.

## MIT License Text

MIT License

Copyright (c) 2026 wangzhezbz

Copyright (c) 2025 Jason Young

Copyright (c) 2026 Codex Dream Skin Studio contributors

Copyright (c) 2011 Einar Otto Stangvik

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
