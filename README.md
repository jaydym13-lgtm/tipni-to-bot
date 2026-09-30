# 🤖 Tipni to! – Backend Daemon

Autonomní stavový daemon v Node.js, který obsluhuje herní data, vyhodnocování zápasů a distribuci statických JSON souborů na Cloudflare R2 pro aplikaci **Tipni to!**.

Místo zatěžování klientských aplikací přímými dotazy do databáze drží daemon aktuální stav soutěží v operační paměti (RAM). V hracích oknech sleduje zápasy přes sportovní feed a veškeré přepočty bodů i statistik odbavuje na pozadí.

---

## 🏗️ Architektura toku dat

1. **Sběr dat:** Pravidelné dotazy na SportAPI7 (rozpisy, kurzy a živé výsledky).
2. **Zpracování v RAM:** Detekce stavu utkání, vyhodnocení tipů podle pravidel jednotlivých lig (včetně hokejových prodloužení a nájezdů), přepočet bodů, žebříčků a ligového radaru.
3. **Distribuce (R2):** Kompilace hotových agregátů do statických JSON souborů (`rozpis.json`, `leaderboard.json`, `hall_of_fame.json`, `cup.json`) a jejich uložení na Cloudflare R2.
4. **Signální maják:** Krátký signální zápis do Firebase Realtime Database (`system/leagues_pulse`), který klientským zařízením indikuje, že mají z CDN načíst nová data.

---

## ⚙️ Klíčové součásti

* **Live Heartbeat Engine:** Sledování stavu zápasů v reálném čase, zamčení tipů v čase výkopu (T-0) a korekce odložených zápasů.
* **Ligová pravidla a přepočet:** Implementace bodovacích pravidel (`rules.js`) pro fotbalové i hokejové soutěže (Chance Liga, Premier League, Tipsport Extraliga, Liga mistrů, MS).
* **Generátor TOP zápasů:** Algoritmus pro vyvážené nasazování šlágrů jednotlivých kol.
* **Pohárový engine:** Hadí nasazování hráčů do skupin po odehrání určeného kola a následná správa vyřazovacího pavouka.
* **Hráčské karty a statistiky:** Analytický výpočet atributů (přesnost, odvaha, forma, stabilita, efektivita) a sestavení souhrnné Síně slávy.

---

## 🛠️ Použité technologie

* **Runtime:** Node.js (>= 22.0.0, ES Modules)
* **Úložiště:** Cloudflare R2 (přes `@aws-sdk/client-s3`)
* **Backend služby:** Firebase Admin SDK (Cloud Firestore, Realtime Database)
* **Běhové prostředí:** Render
