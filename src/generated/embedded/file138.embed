# @ziggy/dev-browser

An optional Ziggy Pi package that invokes the external
[`dev-browser`](https://github.com/SawyerHood/dev-browser) CLI. This adapter was built against
upstream commit `73fe10f045b9c872f963fe6168de4328857e38cf` (`dev-browser` 0.2.9); it does not
vendor upstream code.

Install `dev-browser` and its Chromium runtime separately. Tests can point at a fixture CLI with
`ZIGGY_DEV_BROWSER_BIN`; production normally resolves `dev-browser` from `PATH`.

Each logical profile slug is mapped to a stable, collision-resistant daemon browser name derived
from the Ziggy Profile directory and slug. `browsers`, `status`, and confirmed `stop` remain global
daemon operations. `stop` closes the daemon and every managed browser connection, while persistent
profile directories remain on disk.
