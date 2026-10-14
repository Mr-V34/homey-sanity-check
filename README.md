Know why your Homey Pro restarted. Sanity Check tells a planned restart from an unexpected one and shows which apps crashed in the 24 hours before. You also see which apps and firmware have updates waiting, and which devices have stopped reporting.

Each morning a daily health check lands on your timeline: Homey version and uptime, restart reason, the apps that crashed most, pending updates and silent devices. Flow triggers let you forward restarts, crashes and reports wherever you want.

**An indication, not proof.** If an app crashed 100 times before a restart, it is the likely suspect. Sanity Check reports what happened at the same time and never claims a cause.

## How it works
- One check per hour. The app only reads from Homey and never changes anything.
- Restart detection uses Homey's boot id and restart reason: `reboot` for a planned restart, `unexpected` for a crash or power loss.
- Crash counts are kept per app version. A new version starts with a clean slate.
- After an unplanned restart the app reads Homey's own Insights (RAM/CPU per app, system memory) for the 30 minutes before it, and the Flows with time triggers shortly before. A small 30-day history links restarts and crashes to the time of day.
- A device counts as silent when it has not reported within a limit you set per device class. Right after a Homey restart, devices are only judged once Homey has been running long enough.

## Permissions
`homey:manager:api` gives read access to system info, apps, updates, devices, zones, Insights and Flows. Apps cannot request narrower scopes, and inspecting the whole Homey is this app's main function.

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
