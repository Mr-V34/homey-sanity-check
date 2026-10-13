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
| **Homey restarted** | Homey has a new boot id. Shows the time, the reason (`reboot` = planned restart, `unexpected` = crash or power loss), the previous uptime, and the apps that crashed most in the 24 h before. |
| **App crashed** | An app's crash counter went up since the previous check. Shows the number of crashes, the 24-hour total and the app's memory (PSS) at the check before. *No error message* means Homey most likely stopped the app, for example for using too much memory. The exact time is not known, only that it happened between two checks. |
| **App not running / disabled** | An app went from running to stopped or crashed, or was disabled. |
| **App updated** | An app got a new version. Its crash statistics start over: a new version counts as a new app. |
| **Update available** | A newer app version or Homey firmware is available. |
| **Silent device** | A device has not reported within its limit (see settings). |
| **Daily health check** | Once a day: Homey version, up since, restart reason, restarts in the last 24 h, top crashing apps, pending updates, silent devices, apps above 30 MB PSS (with growth since the day before) and Sanity Check's own memory. |

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

One check per hour, under one second. Sanity Check itself stays under 30 MB PSS. No other modules than Homey itself. The app needs `homey:manager:api` because inspecting the whole Homey is its main function; apps cannot ask for narrower read-only access.

---

## Svenska

### Så fungerar det

En gång i timmen läser appen Homeys systeminfo, installerade appar, tillgängliga uppdateringar och enheter, och jämför med förra kontrollen. Den **läser** bara: den startar aldrig om, uppdaterar eller ändrar något. Första kontrollen körs 2 minuter efter att appen startat, så att andra appar hinner starta efter en omstart.

Allt är en **fingervisning, inte ett bevis**. Om en app kraschade 100 gånger före en omstart är den den troliga misstänkta. Sanity Check visar vad som hände samtidigt och påstår aldrig en orsak.

### Det appen rapporterar

| Rapport | När |
|---|---|
| **Homey startade om** | Homey har ett nytt boot-id. Visar tid, orsak (`reboot` = planerad omstart, `unexpected` = krasch eller strömavbrott), föregående uptime och de appar som kraschade mest under 24 h innan. |
| **En app kraschade** | En apps kraschräknare har ökat sedan förra kontrollen. Visar antal krascher, summan för 24 h och appens minne (PSS) vid kontrollen innan. *Utan felmeddelande* betyder att Homey troligen stoppade appen, till exempel för högt minne. Exakt tid går inte att veta, bara att det hände mellan två kontroller. |
| **App körs inte / avstängd** | En app gick från körs till stoppad eller kraschad, eller stängdes av. |
| **App uppdaterad** | En app fick en ny version. Kraschstatistiken börjar om: en ny version räknas som en ny app. |
| **Uppdatering finns** | En nyare appversion eller Homey-firmware finns. |
| **Tyst enhet** | En enhet har inte rapporterat inom sin gräns (se inställningar). |
| **Daglig hälsokontroll** | En gång per dygn: Homey-version, igång sedan, orsak till senaste omstart, omstarter senaste 24 h, appar som kraschat mest, väntande uppdateringar, tysta enheter, appar över 30 MB PSS (med ökning sedan dagen innan) och Sanity Checks eget minne. |

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

En kontroll i timmen, under en sekund. Sanity Check själv håller sig under 30 MB PSS. Inga andra moduler än Homey själv. Appen behöver `homey:manager:api` eftersom huvudfunktionen är att inspektera hela Homey. Appar kan inte begära en snävare läsbehörighet.
