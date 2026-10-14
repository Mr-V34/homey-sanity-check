Know why your Homey Pro restarted. Sanity Check tells a planned restart from an unexpected one. After an unexpected restart it gives a short verdict: it checks app crashes, apps, power, temperature and load, names the likely cause and gives advice, for example to contact Athom support when nothing points at an app, power or heat. You also see which apps and firmware have updates waiting.

Each morning a daily health check lands on your timeline: Homey version and uptime, restart reason, the apps that crashed most, pending updates and memory. Flow cards let you act on and forward restarts, crashes and reports wherever you want.

**Advice, not proof.** If an app crashed 100 times before a restart, it is the likely suspect. Every line of the verdict says what was measured, and without enough data the verdict says so instead of guessing.

## How it works
- One check per hour. The app only reads from Homey and never changes anything.
- Restart detection uses Homey's boot id and restart reason: `reboot` for a planned restart, `unexpected` for a crash or power loss.
- Crash counts are kept per app version. A new version starts with a clean slate.
- After an unplanned restart the app reads Homey's own Insights once: RAM and CPU per app, Homey's own memory, undervoltage, CPU temperature and load for the 30 minutes before it (and 3 hours before that as this Homey's normal), and the Flows with time triggers shortly before. A small 30-day history links restarts and crashes to the time of day.
- The verdict checks, in order: app crashes, apps that grew, undervoltage, temperature, load. The first problem is the likely cause; when all are fine the verdict is Homey itself. Nothing is measured between restarts beyond the hourly check.

## Permissions
`homey:manager:api` gives read access to system info, apps, updates, Insights and Flows. Apps cannot request narrower scopes, and inspecting the whole Homey is this app's main function.

## Documentation
**[Full manual — every report and setting explained (EN/SV)](docs/MANUAL.md)**

## Development
```
npm install
npm test                 # unit tests for the check logic
homey app validate
homey app install        # permanent install on your Homey Pro
homey app run --remote   # temporary run with live logs
```
