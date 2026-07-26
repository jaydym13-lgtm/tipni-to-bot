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
