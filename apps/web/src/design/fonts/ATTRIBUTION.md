# Bundled fonts

These woff2 files are redistributed with ConfPilot so that an instance makes no
third-party request on page load. Only the `latin` subset and the weights the
stylesheet actually uses are included.

| Family | Weights | License |
| --- | --- | --- |
| Barlow Condensed | 600, 700 | SIL Open Font License 1.1 |
| IBM Plex Sans | 400–700 (variable) | SIL Open Font License 1.1 |
| IBM Plex Mono | 400, 500, 600, 700 | SIL Open Font License 1.1 |

## Copyright notices

- Copyright © 2017 The Barlow Project Authors — <https://github.com/jpt/barlow>
- Copyright © 2017 IBM Corp. with Reserved Font Name "Plex" — <https://github.com/IBM/plex>

`OFL.txt` contains the SIL Open Font License 1.1 and governs every file in this
directory. The copy retained here is the one distributed with IBM Plex; the
license body is identical for Barlow, whose own copyright notice is listed
above.

The OFL permits redistribution and embedding, including in a commercial product,
and imposes no copyleft obligation on the software that uses the fonts. It is
therefore compatible with ConfPilot's AGPL-3.0-or-later license: the fonts stay
under the OFL, the application stays under the AGPL. Note the OFL's Reserved
Font Name clause — do not ship a modified font under the names above.

IBM Plex Sans ships as one variable font covering the whole 400–700 range. That
single file is the same size as one static weight, so it replaces four and cuts
the total font payload roughly in half. Barlow Condensed and IBM Plex Mono have
no variable build on Google Fonts and stay as static weights.

To add or refresh a weight, take the `latin` `@font-face` blocks from the Google
Fonts CSS API and download the referenced woff2 files. Keep this table and
`src/design/fonts.css` in step with what is on disk.
