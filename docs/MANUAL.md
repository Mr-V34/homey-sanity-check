# Sanity Check — Manual

A short guide to the Homey app that tells you why your Homey Pro restarted.

🇬🇧 [English](#english) · 🇸🇪 [Svenska](#svenska)

---

## English

### How it works

Once an hour the app reads Homey's system info, memory, installed apps and available updates, and compares them with the previous check. It only **reads**; it never restarts, updates or changes anything. The first check runs 10 minutes after the app starts, so other apps have time to start after a reboot before it reads anything.

Everything is an **indication, not proof**. If an app crashed 100 times before a restart, it is the likely suspect. After an unplanned restart Sanity Check gives a likely cause as advice, and every line says what was measured.

### What it reports

| Report | When |
|---|---|
| **Homey restarted** | Homey has a new boot id. Shows the time, the reason in plain words (a requested restart or a firmware update is planned; *unexpected* means a crash or power loss), the previous uptime, when we last checked before the restart, and the apps that crashed most in the 24 h before. After an **unplanned** restart it starts with a verdict and adds the restart analysis below. |
| **App crashed** | An app's crash counter went up since the previous check. Shows the number of crashes, the 24-hour total, the app's memory (PSS) at the check before and, when Homey's Insights has it, the **crash time** to within a few seconds. An app that crashes the moment it starts is too short-lived for Insights; its crash gets the check time instead. *No error message* means Homey most likely stopped the app, for example for using too much memory. |
| **App not running / disabled** | An app went from running to stopped or crashed, or was disabled. |
| **App updated** | An app got a new version. Its crash statistics start over: a new version counts as a new app. |
| **Update available** | A newer app version or Homey firmware is available. |
| **Homey slowed down** | Homey's own hardware flags show undervoltage, a temperature limit or a slowed-down processor since it last started. Once per flag and start. |
| **Daily health check** | Once a day: Homey version, up since, restart reason, restarts in the last 24 h, top crashing apps, pending updates, apps above 30 MB PSS (with growth since the day before), free memory, swap and the size of Homey itself, free storage, the apps with most memory in swap (when swap was high), the last successful backup (⚠ when automatic backups are on but none succeeded for 7 days), the firmware channel and automatic updates, recurring times, and Sanity Check's own memory. |

### Restart analysis (unplanned restarts)

Homey logs every app's RAM and CPU, and its own undervoltage, CPU temperature and load, in Insights once a minute, and keeps it across a restart. After an unplanned restart Sanity Check reads the 30 minutes before it (and 3 hours before that, as this Homey's normal), once.

**Verdict first.** The report starts with a checklist, one line per check: ✓ fine, ⚠ points at a cause, – no data.

| Check | ⚠ when | Advice |
|---|---|---|
| App crashes | an app crashed in the 24 h before | update, restart or disable that app |
| Apps | an app's RAM grew 10 MB or more, or high CPU | the same |
| Power | Homey measured undervoltage, or its undervoltage flag was set at the last check | check the power adapter and cable |
| Temperature | 75 °C or more, 10 °C above normal, or Homey had slowed down for heat at the last check | give Homey free air |
| Load | twice the normal load (%) of this Homey | look at heavy Flows and apps |

The first ⚠ in that order is the likely cause. When all checks are ✓ the verdict is **Homey itself**, with the advice to create a diagnostics report in the Homey app (Settings → General) and contact Athom support. That advice is only given when Homey itself calls the restart unexpected; for a reason Sanity Check doesn't know, it asks you to check for an update or a manual restart first. A line about Homey itself (a memory jump in one minute, swap at the last check) supports that verdict. Without enough data the verdict says so and gives no cause. Sanity Check's own memory never counts as a cause: it runs nothing between its checks.

The details below the verdict:

- **When Homey stopped logging.** Insights repeats the last value until Homey is back, so this is often a few minutes before the restart itself.
- **Sudden jumps in Homey's own memory** (more than 30 MB in one minute). Homey's system memory log follows its own process, not the apps.
- **Apps that behaved unusually:** RAM that grew or fell by 10 MB or more, or high CPU.
- **Several apps changing in the same minute.** That points at the system rather than one app.
- **Time-triggered Flows shortly before** (a fixed time, or every N minutes/hours).
- **Recurring times:** unplanned restarts or app crashes around the same time on different days, which may be caused by something scheduled.
- **Crashes before restarts:** an app that crashed within an hour before several unplanned restarts.

Sanity Check keeps a small history (30 days, at most 60 events) for these comparisons. The limits are a first estimate and may change.

### Settings (app settings page)

| Setting | What it does |
|---|---|
| **Daily summary** | Hour of the day (0–23) for the daily health check. Default 08. |

### Flow cards

**Triggers**
- **Homey restarted** — tokens: time, reason, previous uptime (h), possible cause, crashes (24 h).
- **An app crashed** — tokens: app, version, new crashes, crashes (24 h).
- **A report was made** — every timeline report, including the daily summary. Tokens: report, type. Use it to forward reports as a push message or to a log app.

**Conditions**
- **Homey restarted / did not restart unexpectedly in the last [hours] hours** — counts restarts that Homey reports as unplanned, seen since Sanity Check was installed.

**Actions**
- **Run a health check now** — runs the full check and posts a summary to the timeline.

### Memory: RSS and PSS

Homey shows two numbers per app on its performance page:
- **RSS** includes memory shared with other apps. When it gets too high, Homey may stop the app.
- **PSS** is the app's own share. **30 MB** per app is an often quoted target; Sanity Check uses it as its limit, but it is not in Athom's current documentation.

Sanity Check records PSS every hour. An app that crashes without an error message while its PSS keeps growing is the classic sign of a memory leak.

### Load and permissions

One check per hour, under one second. After an unplanned restart, once, about 75 extra read calls (about one second). After an app crash, two extra read calls for that app. Once a day, five read calls for the summary (backup, firmware channel, storage). When swap is 64 MB or more, at most every 6 hours, one read call per running app to see whose memory is in swap. Sanity Check itself uses about 20–30 MB PSS (measured). No other modules than Homey itself. The app needs `homey:manager:api` because inspecting the whole Homey is its main function; apps cannot ask for narrower read-only access.

---

## Svenska

### Så fungerar det

En gång i timmen läser appen Homeys systeminfo, minne, installerade appar och tillgängliga uppdateringar, och jämför med förra kontrollen. Den **läser** bara: den startar aldrig om, uppdaterar eller ändrar något. Första kontrollen körs 10 minuter efter att appen startat, så att andra appar hinner starta efter en omstart innan den läser något.

Allt är en **fingervisning, inte ett bevis**. Om en app kraschade 100 gånger före en omstart är den den troliga misstänkta. Efter en oplanerad omstart ger Sanity Check en trolig orsak som råd, och varje rad säger vad som mättes.

### Det appen rapporterar

| Rapport | När |
|---|---|
| **Homey startade om** | Homey har ett nytt boot-id. Visar tid, orsak i klartext (en begärd omstart eller en firmwareuppdatering är planerad; *oväntad* betyder krasch eller strömavbrott), föregående uptime, när vi senast kontrollerade före omstarten och de appar som kraschade mest under 24 h innan. Efter en **oplanerad** omstart börjar den med ett utlåtande och omstartsanalysen nedan läggs till. |
| **En app kraschade** | En apps kraschräknare har ökat sedan förra kontrollen. Visar antal krascher, summan för 24 h, appens minne (PSS) vid kontrollen innan och, när Homeys Insights har datan, **kraschtiden** på några sekunder när. En app som kraschar direkt när den startar lever för kort för Insights, och då får kraschen kontrolltiden i stället. *Utan felmeddelande* betyder att Homey troligen stoppade appen, till exempel för högt minne. |
| **App körs inte / avstängd** | En app gick från körs till stoppad eller kraschad, eller stängdes av. |
| **App uppdaterad** | En app fick en ny version. Kraschstatistiken börjar om: en ny version räknas som en ny app. |
| **Uppdatering finns** | En nyare appversion eller Homey-firmware finns. |
| **Homey sänkte takten** | Homeys egna hårdvaruflaggor visar underspänning, temperaturgräns eller sänkt processortakt sedan den senast startade. En gång per flagga och start. |
| **Daglig hälsokontroll** | En gång per dygn: Homey-version, igång sedan, orsak till senaste omstart, omstarter senaste 24 h, appar som kraschat mest, väntande uppdateringar, appar över 30 MB PSS (med ökning sedan dagen innan), ledigt minne, swap och hur stor Homey själv är, ledig lagring, apparna med mest minne i swap (när swap var hög), senaste lyckade säkerhetskopia (⚠ när automatisk säkerhetskopiering är på men ingen lyckats på 7 dygn), firmwarekanal och automatisk uppdatering, återkommande tider samt Sanity Checks eget minne. |

### Omstartsanalys (oplanerade omstarter)

Homey loggar varje apps RAM och CPU, och sin egen underspänning, CPU-temperatur och belastning, i Insights en gång i minuten, och sparar det över en omstart. Efter en oplanerad omstart läser Sanity Check de 30 minuterna innan (och 3 timmar före det, som den här Homeyns normala nivå), en gång.

**Utlåtandet först.** Rapporten börjar med en checklista, en rad per kontroll: ✓ normalt, ⚠ pekar på en orsak, – data saknas.

| Kontroll | ⚠ när | Råd |
|---|---|---|
| Appkrascher | en app kraschade under 24 h innan | uppdatera, starta om eller stäng av appen |
| Appar | en apps RAM ökade 10 MB eller mer, eller hög CPU | samma |
| Ström | Homey mätte underspänning, eller dess underspänningsflagga var satt vid senaste kontrollen | kontrollera nätadaptern och kabeln |
| Temperatur | 75 °C eller mer, 10 °C över det normala, eller Homey hade sänkt takten för värme vid senaste kontrollen | ge Homey fri luft |
| Belastning | dubbelt så hög (%) som den här Homeyns normala | se över tunga Flows och appar |

Första ⚠ i den ordningen är den troliga orsaken. När alla kontroller är ✓ blir utlåtandet **Homey själv**, med rådet att skapa en diagnosrapport i Homey-appen (Inställningar → Allmänt) och kontakta Athom support. Det rådet ges bara när Homey själv kallar omstarten oväntad. Vid en orsak som Sanity Check inte känner till ber den dig först kontrollera om Homey uppdaterades eller startades om av någon. En rad om Homey själv (minnessprång på en minut, swap vid senaste kontrollen) stöder det utlåtandet. Med för lite data säger utlåtandet det och anger ingen orsak. Sanity Checks eget minne räknas aldrig som orsak: appen kör inget mellan sina kontroller.

Detaljerna under utlåtandet:

- **När Homey slutade logga.** Insights upprepar det senaste värdet tills Homey är tillbaka, så det är ofta några minuter före själva omstarten.
- **Plötsliga språng i Homeys eget minne** (mer än 30 MB på en minut). Homeys logg för systemminne följer dess egen process, inte apparna.
- **Appar som betedde sig ovanligt:** RAM som ökade eller minskade med 10 MB eller mer, eller hög CPU.
- **Flera appar som ändrades samma minut.** Det pekar mot systemet snarare än en enskild app.
- **Tidsstyrda Flows strax innan** (ett fast klockslag, eller var N:e minut/timme).
- **Återkommande tider:** oplanerade omstarter eller appkrascher kring samma klockslag olika dagar, vilket kan bero på något schemalagt.
- **Krascher före omstarter:** en app som kraschat inom en timme före flera oplanerade omstarter.

Sanity Check sparar en liten historik (30 dagar, högst 60 händelser) för jämförelserna. Gränserna är en första uppskattning och kan ändras.

### Inställningar (appens inställningssida)

| Inställning | Vad den gör |
|---|---|
| **Daglig sammanfattning** | Klockslag (0–23) för den dagliga hälsokontrollen. Standard 08. |

### Flow-kort

**Utlösare**
- **Homey startade om** — taggar: tid, orsak, föregående uptime (h), möjlig orsak, krascher (24 h).
- **En app kraschade** — taggar: app, version, nya krascher, krascher (24 h).
- **En rapport skapades** — varje rapport i tidslinjen, även den dagliga sammanfattningen. Taggar: rapport, typ. Använd den för att skicka vidare som push eller till en loggapp.

**Villkor**
- **Homey startade / startade inte om oväntat de senaste [timmar] timmarna** — räknar omstarter som Homey rapporterar som oplanerade, sedan Sanity Check installerades.

**Åtgärder**
- **Kör en hälsokontroll nu** — kör hela kontrollen och lägger en sammanfattning i tidslinjen.

### Minne: RSS och PSS

Homey visar två siffror per app på sin prestandasida:
- **RSS** räknar med minne som delas med andra appar. Blir den för hög kan Homey stoppa appen.
- **PSS** är appens egen andel. **30 MB** per app är ett ofta citerat mål; Sanity Check använder det som gräns, men det finns inte i Athoms nuvarande dokumentation.

Sanity Check sparar PSS varje timme. En app som kraschar utan felmeddelande medan dess PSS växer är det klassiska tecknet på en minnesläcka.

### Belastning och behörigheter

En kontroll i timmen, under en sekund. Efter en oplanerad omstart, en gång, cirka 75 extra läsanrop (ungefär en sekund). Efter en appkrasch två extra läsanrop för den appen. En gång per dygn fem läsanrop för sammanfattningen (säkerhetskopia, firmwarekanal, lagring). När swap är 64 MB eller mer, som mest var 6:e timme, ett läsanrop per app som körs för att se vems minne som ligger i swap. Sanity Check själv använder cirka 20–30 MB PSS (uppmätt). Inga andra moduler än Homey själv. Appen behöver `homey:manager:api` eftersom huvudfunktionen är att inspektera hela Homey. Appar kan inte begära en snävare läsbehörighet.
