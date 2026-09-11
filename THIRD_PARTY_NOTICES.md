# Third-party notices

The following source is vendored in this repository and retains its own
copyright and license terms.

## Effect source reference and runtime dependency

`repos/effect/` is an unmodified source snapshot of
[Effect](https://github.com/Effect-TS/effect), pinned in `repos/README.md`.
The reference is excluded from app artifacts; the server uses the published
`effect` npm package at the same version.

Copyright (c) 2023 Effectful Technologies Inc

Licensed under the MIT License in `repos/effect/LICENSE`. Bundled third-party
files retain their upstream notices and licenses.

## pi source reference

`repos/pi/` is an unmodified source snapshot of
[pi](https://github.com/earendil-works/pi), pinned in `repos/README.md`.
It is development reference material and is excluded from cube's app artifacts.

Copyright (c) 2025 Mario Zechner

Licensed under the MIT License in `repos/pi/LICENSE`. Any bundled third-party
files retain their upstream notices and licenses.

## Nixpkgs / NixOS Incus module

`scripts/vm/base/incus-container-only.nix` is a modified copy of
`nixos/modules/virtualisation/incus.nix` from
[Nixpkgs](https://github.com/NixOS/nixpkgs), at the revision recorded in
`scripts/vm/base/flake.lock`. The file's opening comment describes the changes.

Copyright (c) 2003-2026 Eelco Dolstra and the Nixpkgs/NixOS contributors

Licensed under the MIT License reproduced below. This applies to the copied
module, not to every package distributed in the VM images; those packages
retain their individual licenses.

## Impeccable 4.1.1

The installed skill distributions under `.agents/skills/impeccable/` and
`.claude/skills/impeccable/` are from
[Impeccable](https://github.com/pbakaus/impeccable).

Copyright 2025 Paul Bakaus

Licensed under the Apache License, Version 2.0. A copy of that license is in
the repository's [LICENSE](LICENSE) file.

## modern-screenshot

The files
`.agents/skills/impeccable/scripts/modern-screenshot.umd.js` and
`.claude/skills/impeccable/scripts/modern-screenshot.umd.js` contain a bundled
copy of [modern-screenshot](https://github.com/qq15725/modern-screenshot).

Copyright (c) 2021-present wxm

Licensed under the MIT License reproduced below.

## Svelte and xterm.js

The built web application contains code from
[Svelte](https://github.com/sveltejs/svelte),
[@xterm/xterm](https://github.com/xtermjs/xterm.js), and
[@xterm/addon-fit](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit).

Copyright (c) 2016-2025 Svelte Contributors

Copyright (c) 2017-2019, The xterm.js authors

Copyright (c) 2014-2016, SourceLair Private Company

Copyright (c) 2012-2013, Christopher Jeffrey

Copyright (c) 2019, The xterm.js authors

These components are licensed under the MIT License reproduced below.

### MIT License

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

## Archivo and JetBrains Mono

The built web application contains fonts from
[Archivo](https://github.com/Omnibus-Type/Archivo) and
[JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), distributed by
Fontsource.

Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo) Archivo-Italic[wdth,wght].ttf: Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)

Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) JetBrainsMono-Italic[wght].ttf: Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

These fonts are licensed under the SIL Open Font License, Version 1.1:

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The fonts,
including any derivative works, can be bundled, embedded, redistributed
and/or sold with any software provided that any reserved names are not used
by derivative works. The fonts and derivatives, however, cannot be released
under any other type of license. The requirement for fonts to remain under
this license does not apply to any document created using the fonts or their
derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may include
source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting, or
substituting -- in part or in whole -- any of the components of the Original
Version, by changing formats or by porting the Font Software to a new
environment.

"Author" refers to any designer, engineer, programmer, technical writer or
other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a copy
of the Font Software, to use, study, copy, merge, embed, modify, redistribute,
and sell modified and unmodified copies of the Font Software, subject to the
following conditions:

1) Neither the Font Software nor any of its individual components, in
Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy contains
the above copyright notice and this license. These can be included either as
stand-alone text files, human-readable headers or in the appropriate
machine-readable metadata fields within text or binary files as long as those
fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font Name(s)
unless explicit written permission is granted by the corresponding Copyright
Holder. This restriction only applies to the primary font name as presented
to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any Modified
Version, except to acknowledge the contribution(s) of the Copyright Holder(s)
and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be
distributed entirely under this license, and must not be distributed under
any other license. The requirement for fonts to remain under this license
does not apply to any document created using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are not
met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT,
TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING ANY GENERAL, SPECIAL,
INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF THE USE OR INABILITY TO USE
THE FONT SOFTWARE OR FROM OTHER DEALINGS IN THE FONT SOFTWARE.
