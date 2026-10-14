Ta reda på varför din Homey Pro startade om. Sanity Check skiljer en planerad omstart från en oväntad och visar vilka appar som kraschade under 24 timmar innan. Du ser också vilka appar och vilken firmware som har uppdateringar som väntar, och vilka enheter som slutat rapportera.

Efter en oplanerad omstart läser appen Homeys egen Insights för minuterna innan: när Homey slutade svara, plötsliga språng i minnet, appar som betedde sig ovanligt och tidsstyrda Flows strax innan. Omstarter och krascher som återkommer vid samma klockslag lyfts fram, eftersom de kan bero på något schemalagt.

Varje morgon kommer en daglig hälsokontroll i tidslinjen: Homey-version och uptime, orsak till senaste omstart, appar som kraschat mest, väntande uppdateringar och tysta enheter. Med Flow-utlösare kan du skicka vidare omstarter, krascher och rapporter dit du vill.

En fingervisning, inte ett bevis: om en app kraschade 100 gånger före en omstart är den den troliga misstänkta. Sanity Check rapporterar vad som hände samtidigt och påstår aldrig en orsak. Appen läser bara från Homey och ändrar aldrig något.

Fullständig manual (alla rapporter och inställningar förklarade):
https://github.com/Mr-V34/homey-sanity-check/blob/main/docs/MANUAL.md
