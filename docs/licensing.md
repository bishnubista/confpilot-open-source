# Licensing

ConfPilot is licensed under the **GNU Affero General Public License, version 3 or later** (AGPL-3.0-or-later). The full text is in [LICENSE](../LICENSE).

This page explains what that means in practice. It is not legal advice; if the obligations matter to your organization, have a lawyer read the license itself.

## Why AGPL

ConfPilot is normally run as a network service. Under a permissive license, a vendor could host a modified ConfPilot as a closed commercial product and contribute nothing back. The AGPL closes that gap: improvements made to a publicly-offered service have to be publishable.

Self-hosting is fully permitted and always was. The AGPL is aimed at the hosted-and-closed case, not at operators running their own conference.

## If you self-host

**Running an unmodified ConfPilot:** no additional obligation. Keep the LICENSE, NOTICE, and copyright notices intact.

**Running a modified ConfPilot that other people use over a network:** AGPL section 13 applies. You must offer those users the Corresponding Source of your modified version. In practice:

1. Publish your modified source somewhere your users can reach — a public fork is the simplest route.
2. Link to it from the running application, so a user of the service can find it.
3. Keep the published source matched to what you actually deployed.

"Other people use it over a network" includes speakers, reviewers, and public attendees browsing the program. An instance used only by you is not offering the service to others.

Configuration is not modification. Setting your event details, hostname, Turnstile keys, or resource names creates no obligation. Editing source files, adding features, or changing behaviour does.

ConfPilot ships a source link in its `/llms.txt` and in the application footer. **If you modify ConfPilot, change that link to point at your source, not upstream.** Pointing at upstream while running different code does not satisfy section 13 and misleads your users.

## If you contribute

Contributions are accepted under the same license as the project: AGPL-3.0-or-later. Inbound equals outbound. You keep the copyright in your contribution; you license it to the project and its users under those terms.

Sign off your commits to certify you have the right to submit the work:

```bash
git commit -s -m "your message"
```

That adds a `Signed-off-by` line asserting the [Developer Certificate of Origin](https://developercertificate.org/). Do not submit code you are not authorized to contribute, including code produced by an AI assistant from sources you have not checked.

## Dual licensing and the CLA decision

The project currently has a **single copyright holder**, which means the holder can relicense or offer commercial licenses at any time. That flexibility is real and worth understanding, because it ends quietly:

**The moment a contribution from someone else is merged, that contributor holds copyright in their lines.** Relicensing then requires their permission, and every later contributor's too. A DCO sign-off certifies provenance; it does **not** grant the project the right to relicense.

So there is a decision to make before the first outside pull request is merged:

- **Accept DCO only.** Simplest, most contributor-friendly, and the project stays AGPL permanently unless every contributor agrees otherwise.
- **Require a CLA** granting the project the right to relicense. Preserves the ability to sell commercial licenses or move to a permissive license later, at the cost of contributor friction.

A CLA is a legal instrument and should be reviewed by a lawyer before it is adopted. Until one exists, this project accepts contributions under DCO and the AGPL only.

## Commercial use

Using ConfPilot to run your conference is commercial use and is fine. The AGPL restricts how you distribute or offer modified versions, not what kind of organization you are or whether you charge for tickets.

If your organization cannot accept the AGPL's source-offering obligation for a modified hosted version, contact the copyright holder about alternative terms.

## Third-party dependencies

Every installed dependency is distributed under a license compatible with releasing the combined work under AGPL-3.0-or-later. Re-check after changing dependencies:

```bash
node scripts/audit-licenses.mjs
```

It exits non-zero if a package declares no license or one that has not been reviewed for compatibility, so a new dependency cannot silently change the project's licensing position.
