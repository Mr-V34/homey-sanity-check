# Sanity Check — Manual

A short guide to the Homey app that tells you why your Homey Pro restarted.

🇬🇧 [English](#english) · 🇸🇪 [Svenska](#svenska)

---

## English

### How it works

Once an hour the app reads Homey's system info, installed apps, available updates and devices, and compares them with the previous check. It only **reads**; it never restarts, updates or changes anything. The first check runs 2 minutes after the app starts, so other apps have time to start after a reboot.

Everything is an **indication, not proof**. If an app crashed 100 times before a restart, it is the likely suspect. Sanity Check shows what happened at the same time and never claims a cause.

### What it reports

| Report | When |
|---|---|
| **Homey restarted** | Homey has a new boot id. Shows the time, the reason (`reboot` = planned restart, `unexpected` = crash or power loss), the previous uptime, when we last checked before the restart, and the apps that crashed most in the 24 h before. After an **unplanned** restart it adds the restart analysis below. |
| **App crashed** | An app's crash counter went up since the previous check. Shows the number of crashes, the 24-hour total, the app's memory (PSS) at the check before and, when Homey's Insights has it, the **crash time** to within a few seconds. An app that crashes the moment it starts is too short-lived for Insights; its crash gets the check time instead. *No error message* means Homey most likely stopped the app, for example for using too much memory. |
| **App not running / disabled** | An app went from running to stopped or crashed, or was disabled. |
| **App updated** | An app got a new version. Its crash statistics start over: a new version counts as a new app. |
| **Update available** | A newer app version or Homey firmware is available. |
| **Silent device** | A device has not reported within its limit (see settings). |
| **Daily health check** | Once a day: Homey version, up since, restart reason, restarts in the last 24 h, top crashing apps, pending updates, silent devices, apps above 30 MB PSS (with growth since the day before), free memory, swap and the size of Homey itself, recurring times, and Sanity Check's own memory. |

### Restart analysis (unplanned restarts)

Homey logs every app's RAM and CPU in Insights, once a minute, and keeps it across a restart. After an unplanned restart Sanity Check reads the 30 minutes before it, once, and reports:

- **When Homey stopped logging.** Insights repeats the last value until Homey is back, so this is often a few minutes before the restart itself.
- **Sudden jumps in system memory** (more than 30 MB in one minute).
- **Apps that behaved unusually:** RAM that grew or fell by 10 MB or more, or high CPU.
- **Several apps changing in the same minute.** That points at the system rather than one app.
- **Time-triggered Flows shortly before** (a fixed time, or every N minutes/hours).
- **Recurring times:** unplanned restarts or app crashes around the same time on different days, which may be caused by something scheduled.
- **Crashes before restarts:** an app that crashed within an hour before several unplanned restarts.

Sanity Check keeps a small history (30 days, at most 60 events) for these comparisons. The limits are a first estimate and may change.

### Settings (app settings page)

| Setting | What it does |
|---|---|
| **Report silent devices** | *Only in the daily summary* (default, no extra messages) · *One message per check* (all devices together) · *One message per device*. |
| **Hours without a report** | Limit per device class before a device counts as silent. 0 = not monitored. Defaults: sensors 24 h, lights and sockets 12 h. Battery sensors can be quiet for hours without anything being wrong. |
| **Daily summary** | Hour of the day (0–23) for the daily health check. Default 08. |

**Right after a Homey restart**, Homey forgets when devices were last seen. Devices are therefore only judged once Homey has been running longer than their limit, so a restart never causes false alarms.

### Flow cards

**Triggers**
- **Homey restarted** — tokens: time, reason, previous uptime (h), possible cause, crashes (24 h).
- **An app crashed** — tokens: app, version, new crashes, crashes (24 h).
- **A report was made** — every timeline report, including the daily summary. Tokens: report, type. Use it to forward reports as a push message or to a log app.

**Actions**
- **Run a health check now** — runs the full check and posts a summary to the timeline.

### Memory: RSS and PSS

Homey shows two numbers per app on its performance page:
- **RSS** includes memory shared with other apps. When it gets too high, Homey may stop the app.
- **PSS** is the app's own share. Athom's guideline is **at most 30 MB** per app.

Sanity Check records PSS every hour. An app that crashes without an error message while its PSS keeps growing is the classic sign of a memory leak.

### Load and permissions

One check per hour, under one second. After an unplanned restart, once, about 70 extra read calls (about one second). After an app crash, two extra read calls for that app. Sanity Check itself stays under 30 MB PSS. No other modules than Homey itself. The app needs `homey:manager:api` because inspecting the whole Homey is its main function; apps cannot ask for narrower read-only access.

---

## Svenska

### Så fungerar det

En gång i timmen läser appen Homeys systeminfo, installerade appar, tillgängliga uppdateringar och enheter, och jämför med förra kontrollen. Den **läser** bara: den startar aldrig om, uppdaterar eller ändrar något. Första kontrollen körs 2 minuter efter att appen startat, så att andra appar hinner starta efter en omstart.

Allt är en **fingervisning, inte ett bevis**. Om en app kraschade 100 gånger före en omstart är den den troliga misstänkta. Sanity Check visar vad som hände samtidigt och påstår aldrig en orsak.

### Det appen rapporterar

| Rapport | När |
|---|---|
| **Homey startade om** | Homey har ett nytt boot-id. Visar tid, orsak (`reboot` = planerad omstart, `unexpected` = krasch eller strömavbrott), föregående uptime, när vi senast kontrollerade före omstarten och de appar som kraschade mest under 24 h innan. Efter en **oplanerad** omstart läggs omstartsanalysen nedan till. |
| **En app kraschade** | En apps kraschräknare har ökat sedan förra kontrollen. Visar antal krascher, summan för 24 h, appens minne (PSS) vid kontrollen innan och, när Homeys Insights har datan, **kraschtiden** på några sekunder när. En app som kraschar direkt när den startar lever för kort för Insights, och då får kraschen kontrolltiden i stället. *Utan felmeddelande* betyder att Homey troligen stoppade appen, till exempel för högt minne. |
| **App körs inte / avstängd** | En app gick från körs till stoppad eller kraschad, eller stängdes av. |
| **App uppdaterad** | En app fick en ny version. Kraschstatistiken börjar om: en ny version räknas som en ny app. |
| **Uppdatering finns** | En nyare appversion eller Homey-firmware finns. |
| **Tyst enhet** | En enhet har inte rapporterat inom sin gräns (se inställningar). |
| **Daglig hälsokontroll** | En gång per dygn: Homey-version, igång sedan, orsak till senaste omstart, omstarter senaste 24 h, appar som kraschat mest, väntande uppdateringar, tysta enheter, appar över 30 MB PSS (med ökning sedan dagen innan), ledigt minne, swap och hur stor Homey själv är, återkommande tider samt Sanity Checks eget minne. |

### Omstartsanalys (oplanerade omstarter)

Homey loggar varje apps RAM och CPU i Insights, en gång i minuten, och sparar det över en omstart. Efter en oplanerad omstart läser Sanity Check de 30 minuterna innan, en gång, och rapporterar:

- **När Homey slutade logga.** Insights upprepar det senaste värdet tills Homey är tillbaka, så det är ofta några minuter före själva omstarten.
- **Plötsliga språng i systemminnet** (mer än 30 MB på en minut).
- **Appar som betedde sig ovanligt:** RAM som ökade eller minskade med 10 MB eller mer, eller hög CPU.
- **Flera appar som ändrades samma minut.** Det pekar mot systemet snarare än en enskild app.
- **Tidsstyrda Flows strax innan** (ett fast klockslag, eller var N:e minut/timme).
- **Återkommande tider:** oplanerade omstarter eller appkrascher kring samma klockslag olika dagar, vilket kan bero på något schemalagt.
- **Krascher före omstarter:** en app som kraschat inom en timme före flera oplanerade omstarter.

Sanity Check sparar en liten historik (30 dagar, högst 60 händelser) för jämförelserna. Gränserna är en första uppskattning och kan ändras.

### Inställningar (appens inställningssida)

| Inställning | Vad den gör |
|---|---|
| **Rapportera tysta enheter** | *Bara i den dagliga sammanfattningen* (standard, inga extra meddelanden) · *Ett meddelande per kontroll* (alla enheter samlat) · *Ett meddelande per enhet*. |
| **Timmar utan rapport** | Gräns per enhetsklass innan en enhet räknas som tyst. 0 = övervakas inte. Standard: sensorer 24 h, lampor och uttag 12 h. Batterisensorer kan vara tysta i flera timmar utan att något är fel. |
| **Daglig sammanfattning** | Klockslag (0–23) för den dagliga hälsokontrollen. Standard 08. |

**Direkt efter en omstart** glömmer Homey när enheter senast hördes av. Enheter bedöms därför först när Homey varit igång längre än deras gräns, så en omstart ger aldrig falsklarm.

### Flow-kort

**Utlösare**
- **Homey startade om** — taggar: tid, orsak, föregående uptime (h), möjlig orsak, krascher (24 h).
- **En app kraschade** — taggar: app, version, nya krascher, krascher (24 h).
- **En rapport skapades** — varje rapport i tidslinjen, även den dagliga sammanfattningen. Taggar: rapport, typ. Använd den för att skicka vidare som push eller till en loggapp.

**Åtgärder**
- **Kör en hälsokontroll nu** — kör hela kontrollen och lägger en sammanfattning i tidslinjen.

### Minne: RSS och PSS

Homey visar två siffror per app på sin prestandasida:
- **RSS** räknar med minne som delas med andra appar. Blir den för hög kan Homey stoppa appen.
- **PSS** är appens egen andel. Athoms riktvärde är **högst 30 MB** per app.

Sanity Check sparar PSS varje timme. En app som kraschar utan felmeddelande medan dess PSS växer är det klassiska tecknet på en minnesläcka.

### Belastning och behörigheter

En kontroll i timmen, under en sekund. Efter en oplanerad omstart, en gång, cirka 70 extra läsanrop (ungefär en sekund). Efter en appkrasch två extra läsanrop för den appen. Sanity Check själv håller sig under 30 MB PSS. Inga andra moduler än Homey själv. Appen behöver `homey:manager:api` eftersom huvudfunktionen är att inspektera hela Homey. Appar kan inte begära en snävare läsbehörighet.
