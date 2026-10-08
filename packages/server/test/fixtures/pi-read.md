# Pi read image fixtures

`pi-read.png` and `pi-read.jpg` were authored for this test in Chromium 153
through Playwright's canvas API, not copied from user data. Both depict the
same 360×180 canvas:

- white background;
- `#cc3f00` square at (20,20), size 80×80;
- `#245ab5` circle centered at (180,60), radius 40;
- `#111` text `cube 427`, 24px sans-serif, baseline (20,150).

Canvas `toDataURL("image/png")` / `toDataURL("image/jpeg")` produced the files.
The offline provider asserts typed bytes, not their visual meaning. This
provenance is not evidence of visual inspection by a real model.
