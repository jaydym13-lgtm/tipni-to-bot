// =========================================================================
// 📜 TIPNI TO! - CENTRÁLNÍ MATICE PRAVIDEL A BODOVÁNÍ (rules.js)
// =========================================================================

export const PRAVIDLA_LIG = {
    "MS ve fotbale": {
        presnyVysledek: 6,
        chytraTendence: 3,
        zakladniTendence: 2,
        golUtechy: 1,
        playoffBonus: 1,
        penaltyNenatipovano: -1,
        bonusVitez: 8,
        bonusStrelec: 8,
        hasTopMatch: false,
        topMatchMultiplier: 1,
        roundBonus: 0              // Bez bonusu za celé kolo
    },
    "Chance Liga": {
        presnyVysledek: 5,
        chytraTendence: 0,
        zakladniTendence: 2,       // Správný vítěz nebo nepřesná remíza
        golUtechy: 0,
        playoffBonus: 0,
        penaltyNenatipovano: -1,   // -1b za nenatipovaný zápas
        bonusVitez: 0,             // Netipuje se celkový vítěz
        bonusStrelec: 10,          // 10 bodů za střelce
        hasTopMatch: true,         // Mechanika TOP ZÁPASU aktivní
        topMatchMultiplier: 2,     // 2x násobič zisku
        roundBonus: 5              // 🔥 +5 bodů za trefení tendence VŠECH zápasů v kole
    },
    "Premier League": {
        presnyVysledek: 6,
        chytraTendence: 3,
        zakladniTendence: 2,
        golUtechy: 1,
        playoffBonus: 0,
        penaltyNenatipovano: -1,   // -1b za nenatipovaný zápas
        bonusVitez: 10,            // 🔥 10 bodů za celkového vítěze
        bonusStrelec: 10,          // 🔥 10 bodů za nejlepšího střelce
        hasTopMatch: true,          // Mechanika TOP ZÁPASU aktivní
        topMatchMultiplier: 2,      // 2x násobič zisku
        roundBonus: 0              // Bez bonusu za celé kolo
    },
        "Liga mistrů": {
        presnyVysledek: 6,
        chytraTendence: 3,
        zakladniTendence: 2,
        golUtechy: 1,
        playoffBonus: 0,           // ❌ Vypnuto pro LM (tipuje se čistě po 90 minutách)
        penaltyNenatipovano: -1,   // -1b za nenatipovaný zápas
        bonusVitez: 0,             // ❌ Vypnuto pro LM
        bonusStrelec: 0,           // ❌ Vypnuto pro LM
        hasTopMatch: false,        // ❌ Vypnuto pro LM
        topMatchMultiplier: 1,
        roundBonus: 0              // ❌ Bez bonusu za celé kolo
    },
        "MS v hokeji": {
        presnyVysledek: 3,
        chytraTendence: 0,
        zakladniTendence: 1,
        golUtechy: 0,
        playoffBonus: 0,
        penaltyNenatipovano: 0,
        bonusVitez: 10,
        bonusStrelec: 10,
        hasTopMatch: false,
        topMatchMultiplier: 1,
        roundBonus: 0
    },
    "Tipsport Extraliga": {
        presnyVysledek: 5,
        chytraTendence: 3,         // Základ pro nepřesnou remízu = 3 b.
        presnaRemiza: 6,           // Základ pro přesnou remízu = 6 b.
        zakladniTendence: 2,
        golUtechy: 0,
        playoffBonus: 1,           // +1 b. za vítěze v OT / SN
        penaltyNenatipovano: -1,
        bonusVitez: 10,
        bonusStrelec: 8,
        bonusKanadskeBodovani: 8,
        hasTopMatch: true,
        topMatchMultiplier: 2,
        roundBonus: 5
    },
    "DEFAULT": {
        presnyVysledek: 3,
        chytraTendence: 0,
        zakladniTendence: 1,
        golUtechy: 0,
        playoffBonus: 0,
        penaltyNenatipovano: 0,
        bonusVitez: 10,
        bonusStrelec: 10,
        hasTopMatch: false,
        topMatchMultiplier: 1,
        roundBonus: 0
    }
};

// Zpětná kompatibilita pro vanilkový frontend
if (typeof window !== 'undefined') {
    window.PRAVIDLA_LIG = PRAVIDLA_LIG;
}

// =========================================================================
// 🧮 CENTRÁLNÍ KALKULÁTOR BODŮ PRO ZÁPASY
// =========================================================================
export const vypocitejBodyZapasu = (tipDomaci, tipHoste, resDomaci, resHoste, leagueName, tipPostup, resPostup, isPlayoff, isTopMatch = false) => {
    if (resDomaci === undefined || resHoste === undefined || resDomaci === null || resHoste === null) return 0;
    
    const pravidla = PRAVIDLA_LIG[leagueName] || PRAVIDLA_LIG["DEFAULT"];

    // ⚠️ NENATIPOVANÝ ZÁPAS
    if (tipDomaci === undefined || tipHoste === undefined || tipDomaci === null || tipHoste === null || tipDomaci === '' || tipHoste === '') {
        return pravidla.penaltyNenatipovano || 0;
    }

    const tD = parseInt(tipDomaci);
    const tH = parseInt(tipHoste);
    const rD = parseInt(resDomaci);
    const rH = parseInt(resHoste);

    let body = 0;

    // 🏒 1. TIPSPORT EXTRALIGA
    if (leagueName === "Tipsport Extraliga") {
        const jeTipRemiza = (tD === tH);
        const jeRealRemiza = (rD === rH);

        const trefilPostup = Boolean(tipPostup && resPostup && tipPostup === resPostup);

        if (jeTipRemiza && jeRealRemiza) {
            const jePresnaRemiza = (tD === rD && tH === rH);
            if (isTopMatch) {
                return jePresnaRemiza 
                    ? (trefilPostup ? 11 : 10)
                    : (trefilPostup ? 8 : 6);
            } else {
                return jePresnaRemiza
                    ? (trefilPostup ? 7 : 6)
                    : (trefilPostup ? 4 : 3);
            }
        } else if (!jeTipRemiza && !jeRealRemiza) {
            const presny = (tD === rD && tH === rH);
            const spravnaTendence = (tD > tH && rD > rH) || (tD < tH && rD < rH);

            if (presny) {
                return isTopMatch ? 10 : 5;
            } else if (spravnaTendence) {
                return isTopMatch ? 4 : 2;
            } else {
                return -1;
            }
        } else {
            return -1;
        }
    }
    // ⚽ 2. CHANCE LIGA & LIGA NÁRODŮ
    else if (leagueName === "Chance Liga" || leagueName === "Liga národů") {
        const presny = (tD === rD && tH === rH);
        const spravnaTendence = (tD > tH && rD > rH) || (tD < tH && rD < rH) || (tD === tH && rD === rH);
        
        if (presny) body = pravidla.presnyVysledek;
        else if (spravnaTendence) body = pravidla.zakladniTendence;
        else body = 0;

        if (isPlayoff && tD === tH && rD === rH && tipPostup && resPostup && tipPostup === resPostup) {
            body += pravidla.playoffBonus;
        }
    }
    // ⚽ 3. MS VE FOTBALE, PREMIER LEAGUE & LIGA MISTRŮ
    else if (leagueName === "MS ve fotbale" || leagueName === "Premier League" || leagueName === "Liga mistrů") {
        const presny = (tD === rD && tH === rH);
        const spravnaTendence = (tD > tH && rD > rH) || (tD < tH && rD < rH) || (tD === tH && rD === rH);
        const presneGolyJednoho = (tD === rD || tH === rH);
        const presnyRozdil = ((tD - tH) === (rD - rH));

        if (presny) {
            body = pravidla.presnyVysledek;
        } else if (spravnaTendence) {
            if (presneGolyJednoho || presnyRozdil) body = pravidla.chytraTendence;
            else body = pravidla.zakladniTendence;
        } else if (presneGolyJednoho) {
            body = pravidla.golUtechy;
        } else {
            body = 0;
        }

        if (isPlayoff && tD === tH && rD === rH && tipPostup && resPostup && tipPostup === resPostup) {
            body += pravidla.playoffBonus;
        }
    }
    // 🏒 4. OSTATNÍ (MS V HOKEJI & DEFAULT)
    else {
        const presny = (tD === rD && tH === rH);
        const spravnaTendence = (tD > tH && rD > rH) || (tD < tH && rD < rH) || (tD === tH && rD === rH);

        if (presny) body = pravidla.presnyVysledek;
        else if (spravnaTendence) body = pravidla.zakladniTendence;
        else body = 0;
    }

    // 🔥 DVOJNÁSOBEK BODŮ PRO TOP ZÁPAS (2x)
    if (isTopMatch && body > 0 && pravidla.hasTopMatch) {
        body = body * pravidla.topMatchMultiplier;
    }

    return body;
};

if (typeof window !== 'undefined') {
    window.vypocitejBodyZapasu = vypocitejBodyZapasu;
}
