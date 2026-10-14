Know why your Homey Pro restarted. Sanity Check tells a planned restart from an unexpected one and shows which apps crashed in the 24 hours before. You also see which apps and firmware have updates waiting, and which devices have stopped reporting.

After an unplanned restart the app reads Homey's own Insights for the minutes before it: when Homey stopped responding, sudden memory jumps, apps that behaved unusually and time-triggered Flows shortly before. Restarts and crashes that come back at the same time of day are pointed out, since they may be caused by something scheduled.

Each morning a daily health check lands on your timeline: Homey version and uptime, restart reason, the apps that crashed most, pending updates and silent devices. Flow triggers let you forward restarts, crashes and reports wherever you want.

An indication, not proof: if an app crashed 100 times before a restart, it is the likely suspect. Sanity Check reports what happened at the same time and never claims a cause. The app only reads from Homey and never changes anything.

Full manual (every report and setting explained):
https://github.com/Mr-V34/homey-sanity-check/blob/main/docs/MANUAL.md
