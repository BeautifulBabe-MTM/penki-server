const DEFAULT_CONFIG = {
    use52: false,
    handSizeOnDeal: 1,
    fullHandSize: 6,
};

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS36 = [6, 7, 8, 9, 10, 11, 12, 13, 14];
const RANKS52 = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

function makeDeck(use52 = false) {
    const ranks = use52 ? RANKS52 : RANKS36;
    const deck = [];
    for (const r of ranks) {
        for (const s of SUITS) {
            deck.push({ rank: r, suit: s, id: `${s}_${r}` });
        }
    }
    return shuffle(deck);
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function cardToString(c) {
    if (!c) return '??';
    const map = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
    return `${map[c.rank] || c.rank}${c.suit}`;
}

function isHigherRank(aRank, bRank) {
    return aRank > bRank;
}

function canBeat(attackCard, defenceCard, trumpSuit, use52 = false) {
    if (!attackCard || !defenceCard) return false;
    if (attackCard.suit === '♠') {
        if (defenceCard.suit !== '♠') return false;
        return isHigherRank(defenceCard.rank, attackCard.rank);
    }
    if (defenceCard.suit === attackCard.suit && isHigherRank(defenceCard.rank, attackCard.rank)) return true;
    if (trumpSuit && defenceCard.suit === trumpSuit && attackCard.suit !== '♠') return true;
    return false;
}

class Player {
    constructor(id, socketId, name = 'Player') {
        this.id = id;
        this.socketId = socketId || null;
        this.name = name;
        this.hand = []; // visible/usable cards
        this.penki = []; // 2 hidden cards
        this.openCard = null; // single open card for starter determination
        this.out = false; // finished round (no cards and no penki)
        this.penekCount = 0; // count across games
    }
}

class Game {
    constructor(id, config = {}) {
        this.id = id;
        this.config = Object.assign({}, DEFAULT_CONFIG, config);
        this.players = [];
        this.deck = [];
        this.discard = []; // отбои
        this.stack = [];
        this.trump = null;
        this.lastDrawerIndex = null;
        this.currentAttacker = 0; // index in players
        this.currentDefender = 1; // index in players
        this.started = false;
        this.logs = [];
    }

    log(...args) {
        const s = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        this.logs.push(s);
        if (this.logs.length > 200) this.logs.shift();
    }

    addPlayer(id, socketId, name = 'Player') {
        if (this.started) throw new Error('Игра уже началась');
        const maxPlayers = this.config.use52 ? 6 : 4;
        if (this.players.length >= maxPlayers) throw new Error(`Максимум ${maxPlayers} игроков`);
        const p = new Player(id, socketId, name);
        this.players.push(p);
        return p;
    }

    removePlayerBySocket(socketId) {
        const idx = this.players.findIndex(p => p.socketId === socketId);
        if (idx >= 0) this.players.splice(idx, 1);
    }

    getPlayerIndexById(id) {
        return this.players.findIndex(p => p.id === id);
    }

    getNextIndex(idx) {
        if (this.players.length === 0) return -1;
        return (idx + 1) % this.players.length;
    }

    dealInitial() {
        this.deck = makeDeck(this.config.use52);
        for (const p of this.players) {
            p.penki = [this.deck.pop(), this.deck.pop()];
        }
        for (const p of this.players) {
            p.openCard = this.deck.pop();
        }
    }

    determineFirstDrawer() {
        let maxRank = -Infinity;
        let candidates = [];
        for (let i = 0; i < this.players.length; i++) {
            const r = this.players[i].openCard.rank;
            if (r > maxRank) { maxRank = r; candidates = [i]; }
            else if (r === maxRank) candidates.push(i);
        }
        if (candidates.length === 1) {
            return candidates[0];
        }
        while (candidates.length > 1 && this.deck.length > 0) {
            const revealed = [];
            for (const idx of candidates) {
                const c = this.deck.pop();
                revealed.push({ idx, card: c });
            }
            let highest = -Infinity;
            let newCandidates = [];
            for (const r of revealed) {
                if (r.card.rank > highest) { highest = r.card.rank; newCandidates = [r.idx]; }
                else if (r.card.rank === highest) newCandidates.push(r.idx);
            }
            candidates = newCandidates;
        }
        return candidates[0] || 0;
    }

    start() {
        if (this.players.length < 2) throw new Error('Требуется >=2 игрока');
        this.dealInitial();
        this.replenishHands();

        const drawerIndex = this.determineFirstDrawer();

        const drawn = this.deck.pop();
        if (drawn) {
            this.lastDrawerIndex = drawerIndex;
            this.stack.push(drawn);
            this.trump = (drawn.suit === '♠' ? null : drawn.suit);
        }

        this.currentAttacker = drawerIndex;
        this.currentDefender = this.getNextIndex(drawerIndex);

        this.started = true;
        this.log('Игра началась', { drawerIndex, trump: this.trump });
    }

    playerAt(idx) {
        if (this.players.length === 0) return null;
        return this.players[idx % this.players.length];
    }

    playCard(playerId, cardId) {
        if (!this.started) throw new Error('Игра не началась');
        const attackerIdx = this.getPlayerIndexById(playerId);
        if (attackerIdx !== this.currentAttacker) throw new Error('Не твоя очередь атаковать');
        const attacker = this.players[attackerIdx];
        const ci = attacker.hand.findIndex(c => c.id === cardId);
        if (ci < 0) throw new Error('Карта не в руке');
        const card = attacker.hand.splice(ci, 1)[0];
        this.stack.push(card);
        this.log(`${attacker.name} атакует ${cardToString(card)}`);
        if (card.suit === '♠' && card.rank === 7) {
            this.log('7♠ сыграно - мгновенное закрытие атакующим');
            return this.closeRoundBy(attackerIdx);
        }
        return { status: 'ok', stack: this.stack.slice() };
    }

    defendWith(playerId, defenceCardId) {
        if (!this.started) throw new Error('Игра не началась');

        const defenderIdx = this.getPlayerIndexById(playerId);
        if (defenderIdx !== this.currentDefender) throw new Error('Не твоя очередь защищаться');

        const defender = this.players[defenderIdx];

        if (this.stack.length === 0) throw new Error('Нечего защищать');

        const attackCard = this.stack[this.stack.length - 1];
        const di = defender.hand.findIndex(c => c.id === defenceCardId);

        if (di < 0) throw new Error('Карта защиты не в руке');

        const defenceCard = defender.hand[di];

        // 7♠ мгновенно закрывает ход
        if (defenceCard.suit === '♠' && defenceCard.rank === 7) {
            defender.hand.splice(di, 1);
            this.stack.push(defenceCard);
            this.log(`${defender.name} сыграл 7♠ - мгновенное закрытие круга`);
            return this.closeRoundBy(defenderIdx);
        }

        if (!canBeat(attackCard, defenceCard, this.trump, this.config.use52)) {
            throw new Error('Невозможно отразить эту атаку выбранной картой');
        }

        defender.hand.splice(di, 1);
        this.stack.push(defenceCard);
        this.log(`${defender.name} побил ${cardToString(attackCard)} картой ${cardToString(defenceCard)}`);

        // Следующий игрок должен отбиваться
        this.currentDefender = this.getNextIndex(this.currentDefender);

        // Проверка: если следующий игрок не может побить нижнюю карту
        let rounds = 0;
        while (rounds < this.players.length) {
            const nextPlayer = this.players[this.currentDefender];
            const bottomCard = this.stack[0];
            const canBeatBottom = nextPlayer.hand.some(c => canBeat(bottomCard, c, this.trump, this.config.use52));

            if (!canBeatBottom) {
                // игрок берёт нижнюю карту
                const taken = this.stack.shift();
                nextPlayer.hand.push(taken);
                this.log(`${nextPlayer.name} не может отбиться и берёт карту ${cardToString(taken)}`);
            }

            this.currentDefender = this.getNextIndex(this.currentDefender);
            rounds++;
        }

        // Если стек пуст или все игроки имели шанс отбиться => закрываем круг
        if (this.stack.length === 0 || rounds >= this.players.length) {
            return this.closeRoundBy(this.currentAttacker);
        }

        return {
            status: 'defended',
            stack: this.stack.slice(),
            currentAttacker: this.currentAttacker,
            currentDefender: this.currentDefender
        };
    }

    takeBottom(playerId) {
        const defenderIdx = this.getPlayerIndexById(playerId);
        if (defenderIdx !== this.currentDefender) throw new Error('Не твоя очередь брать');
        const defender = this.players[defenderIdx];
        if (this.stack.length === 0) throw new Error('В стопке нет карт, которые можно взять');
        const bottom = this.stack.shift(); // remove bottom
        defender.hand.push(bottom);
        this.log(`${defender.name} не смог отбиться и забрал карту ${cardToString(bottom)}`);
        this.currentAttacker = this.getNextIndex(this.currentAttacker);
        this.currentDefender = this.getNextIndex(this.currentAttacker);
        return { status: 'took', taken: bottom, stack: this.stack.slice(), currentAttacker: this.currentAttacker, currentDefender: this.currentDefender };
    }

    closeRoundBy(playerIdx) {
        while (this.stack.length) this.discard.push(this.stack.shift());

        this.currentAttacker = playerIdx;
        this.currentDefender = this.getNextIndex(playerIdx);

        this.revealPenkiWhereNeeded();

        this.log(`Раунд закрыт. Козырь: ${this.trump}`);

        return {
            status: 'closed',
            currentAttacker: this.currentAttacker,
            currentDefender: this.currentDefender,
            stack: this.stack.slice()
        };
    }

    replenishHands() {
        for (const p of this.players) {
            while (p.hand.length < this.config.fullHandSize && this.deck.length > 0) {
                p.hand.push(this.deck.pop());
            }
        }
    }

    revealPenkiWhereNeeded() {
        for (const p of this.players) {
            if (p.hand.length === 0 && p.penki && p.penki.length > 0) {
                p.hand.push(...p.penki);
                p.penki = [];
                this.log(`${p.name} взял пеньки`);
            }
        }
        for (const p of this.players) {
            if (p.hand.length === 0 && (!p.penki || p.penki.length === 0)) {
                p.out = true;
            }
        }
    }

    publicStateFor(playerId) {
        return {
            players: this.players.map(p => ({
                id: p.id,
                name: p.name,
                hand: p.id === playerId ? p.hand : [], // показываем чужие руки пустыми
                out: p.out,
            })),
            stack: this.stack,
            logs: this.logs,
        };
    }
}

module.exports = { Game, makeDeck, Player, canBeat, cardToString };
