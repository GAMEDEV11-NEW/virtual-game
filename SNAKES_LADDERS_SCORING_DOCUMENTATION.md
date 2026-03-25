# 🎯 Snakes and Ladders - Complete Scoring Table

## 📊 MASTER SCORING TABLE - ALL CASES

This is the **ONE TABLE** that shows every possible case and the points you get:

| # | Action / Case | Points | Breakdown | Notes |
|---|---------------|--------|-----------|-------|
| **DICE ROLL POINTS** |
| 1 | Roll **1** | **+2** | 1 (dice) + 1 (lucky bonus) | Lucky roll bonus |
| 2 | Roll **2** | **+2** | 2 (dice number) | Normal roll |
| 3 | Roll **3** | **+3** | 3 (dice number) | Normal roll |
| 4 | Roll **4** | **+4** | 4 (dice number) | Normal roll |
| 5 | Roll **5** | **+5** | 5 (dice number) | Normal roll |
| 6 | Roll **6** (first time) | **+16** | 6 (dice) + 10 (six bonus) | Get another turn |
| 7 | Roll **6** (second consecutive) | **+20** | 6 (dice) + 10 (six) + 4 (consecutive) | Get another turn |
| 8 | Roll **6** (third consecutive) | **+16** | 6 (dice) + 10 (six) | Turn passes to opponent |
| **PIECE MOVEMENT POINTS** |
| 9 | Move piece (normal move) | **+1** | 1 (base move) | No snake or ladder |
| 10 | Move piece and climb **ladder** | **+6** | 1 (move) + 5 (ladder bonus) | Climbed up |
| 11 | Move piece and land on **snake** | **-4** | 1 (move) - 5 (snake penalty) | Slid down |
| 12 | Move piece and **WIN** (normal) | **+51** | 1 (move) + 50 (win bonus) | All pieces at 100 |
| 13 | Move piece, climb **ladder**, and **WIN** | **+56** | 1 (move) + 5 (ladder) + 50 (win) | Win with ladder |
| 14 | Move piece, land on **snake**, and **WIN** | **+46** | 1 (move) - 5 (snake) + 50 (win) | Win despite snake |
| **QUIT GAME** |
| 15 | Quit the game | **0** | No penalty | Currently no penalty |
| **COMBINED SCENARIOS** |
| 16 | Roll 1 → Move normal | **+3 total** | 2 (roll) + 1 (move) | Complete turn |
| 17 | Roll 2 → Move normal | **+3 total** | 2 (roll) + 1 (move) | Complete turn |
| 18 | Roll 3 → Move normal | **+4 total** | 3 (roll) + 1 (move) | Complete turn |
| 19 | Roll 4 → Move normal | **+5 total** | 4 (roll) + 1 (move) | Complete turn |
| 20 | Roll 5 → Move normal | **+6 total** | 5 (roll) + 1 (move) | Complete turn |
| 21 | Roll 6 (1st) → Move normal | **+17 total** | 16 (roll) + 1 (move) | Complete turn |
| 22 | Roll 6 (1st) → Move ladder | **+22 total** | 16 (roll) + 6 (ladder move) | Complete turn |
| 23 | Roll 6 (1st) → Move snake | **+12 total** | 16 (roll) - 4 (snake move) | Complete turn |
| 24 | Roll 6 (2nd) → Move normal | **+21 total** | 20 (roll) + 1 (move) | Complete turn |
| 25 | Roll 6 (2nd) → Move ladder | **+26 total** | 20 (roll) + 6 (ladder move) | Complete turn |
| 26 | Roll 6 (2nd) → Move snake | **+16 total** | 20 (roll) - 4 (snake move) | Complete turn |
| 27 | Roll 6 (3rd) → Move normal | **+17 total** | 16 (roll) + 1 (move) | Turn passes after |
| 28 | Roll 6 (3rd) → Move ladder | **+22 total** | 16 (roll) + 6 (ladder move) | Turn passes after |
| 29 | Roll 6 (3rd) → Move snake | **+12 total** | 16 (roll) - 4 (snake move) | Turn passes after |
| 30 | Roll 1 → Move ladder | **+8 total** | 2 (roll) + 6 (ladder move) | Complete turn |
| 31 | Roll 1 → Move snake | **-2 total** | 2 (roll) - 4 (snake move) | Complete turn |
| 32 | Roll 2 → Move ladder | **+8 total** | 2 (roll) + 6 (ladder move) | Complete turn |
| 33 | Roll 2 → Move snake | **-2 total** | 2 (roll) - 4 (snake move) | Complete turn |
| 34 | Roll 3 → Move ladder | **+9 total** | 3 (roll) + 6 (ladder move) | Complete turn |
| 35 | Roll 3 → Move snake | **-1 total** | 3 (roll) - 4 (snake move) | Complete turn |
| 36 | Roll 4 → Move ladder | **+10 total** | 4 (roll) + 6 (ladder move) | Complete turn |
| 37 | Roll 4 → Move snake | **0 total** | 4 (roll) - 4 (snake move) | Complete turn |
| 38 | Roll 5 → Move ladder | **+11 total** | 5 (roll) + 6 (ladder move) | Complete turn |
| 39 | Roll 5 → Move snake | **+1 total** | 5 (roll) - 4 (snake move) | Complete turn |
| 40 | Roll 1 → Move and WIN | **+53 total** | 2 (roll) + 51 (win move) | Complete turn |
| 41 | Roll 2 → Move and WIN | **+53 total** | 2 (roll) + 51 (win move) | Complete turn |
| 42 | Roll 3 → Move and WIN | **+54 total** | 3 (roll) + 51 (win move) | Complete turn |
| 43 | Roll 4 → Move and WIN | **+55 total** | 4 (roll) + 51 (win move) | Complete turn |
| 44 | Roll 5 → Move and WIN | **+56 total** | 5 (roll) + 51 (win move) | Complete turn |
| 45 | Roll 6 (1st) → Move and WIN | **+67 total** | 16 (roll) + 51 (win move) | Complete turn |
| 46 | Roll 6 (2nd) → Move and WIN | **+71 total** | 20 (roll) + 51 (win move) | Complete turn |
| 47 | Roll 6 (3rd) → Move and WIN | **+67 total** | 16 (roll) + 51 (win move) | Turn passes after |
| 48 | Roll 1 → Move ladder and WIN | **+58 total** | 2 (roll) + 56 (ladder win) | Complete turn |
| 49 | Roll 2 → Move ladder and WIN | **+58 total** | 2 (roll) + 56 (ladder win) | Complete turn |
| 50 | Roll 3 → Move ladder and WIN | **+59 total** | 3 (roll) + 56 (ladder win) | Complete turn |
| 51 | Roll 4 → Move ladder and WIN | **+60 total** | 4 (roll) + 56 (ladder win) | Complete turn |
| 52 | Roll 5 → Move ladder and WIN | **+61 total** | 5 (roll) + 56 (ladder win) | Complete turn |
| 53 | Roll 6 (1st) → Move ladder and WIN | **+72 total** | 16 (roll) + 56 (ladder win) | Complete turn |
| 54 | Roll 6 (2nd) → Move ladder and WIN | **+76 total** | 20 (roll) + 56 (ladder win) | Complete turn |
| 55 | Roll 6 (3rd) → Move ladder and WIN | **+72 total** | 16 (roll) + 56 (ladder win) | Turn passes after |
| 56 | Roll 1 → Move snake and WIN | **+48 total** | 2 (roll) + 46 (snake win) | Complete turn |
| 57 | Roll 2 → Move snake and WIN | **+48 total** | 2 (roll) + 46 (snake win) | Complete turn |
| 58 | Roll 3 → Move snake and WIN | **+49 total** | 3 (roll) + 46 (snake win) | Complete turn |
| 59 | Roll 4 → Move snake and WIN | **+50 total** | 4 (roll) + 46 (snake win) | Complete turn |
| 60 | Roll 5 → Move snake and WIN | **+51 total** | 5 (roll) + 46 (snake win) | Complete turn |
| 61 | Roll 6 (1st) → Move snake and WIN | **+62 total** | 16 (roll) + 46 (snake win) | Complete turn |
| 62 | Roll 6 (2nd) → Move snake and WIN | **+66 total** | 20 (roll) + 46 (snake win) | Complete turn |
| 63 | Roll 6 (3rd) → Move snake and WIN | **+62 total** | 16 (roll) + 46 (snake win) | Turn passes after |

---

## 📋 QUICK REFERENCE BY CATEGORY

### 🎲 DICE ROLL ONLY
| Roll | Points |
|------|--------|
| 1 | +2 |
| 2 | +2 |
| 3 | +3 |
| 4 | +4 |
| 5 | +5 |
| 6 (1st time) | +16 |
| 6 (2nd consecutive) | +20 |
| 6 (3rd consecutive) | +16 (lose turn) |

### 🎯 MOVE ONLY
| Move Type | Points |
|-----------|--------|
| Normal move | +1 |
| Ladder move | +6 |
| Snake move | -4 |
| Win move (normal) | +51 |
| Win move (with ladder) | +56 |
| Win move (with snake) | +46 |

### ❌ OTHER
| Action | Points |
|--------|--------|
| Quit game | 0 |

---

## 🎮 HOW TO USE THIS TABLE

1. **Find your action** in the table
2. **Check the points** you get
3. **See the breakdown** to understand why
4. **Read the notes** for special conditions

---

## 📝 IMPORTANT NOTES

- **Roll 6 three times**: You get 16 points, but your turn passes to the opponent
- **Snake moves**: Can make your score negative
- **Win bonus**: Always +50 points added to your move
- **Quit penalty**: Currently 0 (no penalty)
- **Consecutive six bonus**: Only applies on 2nd consecutive six (+4 bonus)

---

## 💡 EXAMPLES FROM TABLE

**Example 1:**
- You roll 6 (first time) → **+16 points** (Row 6)
- You move normally → **+1 point** (Row 9)
- **Total for turn: +17 points** (Row 21)

**Example 2:**
- You roll 6 (second time) → **+20 points** (Row 7)
- You move and climb ladder → **+6 points** (Row 10)
- **Total for turn: +26 points** (Row 25)

**Example 3:**
- You roll 3 → **+3 points** (Row 3)
- You move and WIN → **+51 points** (Row 12)
- **Total for turn: +54 points** (Row 42)

---

*Last Updated: Based on current codebase*  
*Complete Table - All Cases Covered* ✨
