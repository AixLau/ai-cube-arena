import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_MOVES, applyMoves, invertAlg, isSolved, parseAlg, parseMove, randomScramble, solvedState,
} from './cube.ts';

const str = (alg: string) => applyMoves(solvedState(), parseAlg(alg)).join('');

test('单步转动与 Kociemba 标准展开一致', () => {
  assert.equal(str('R'), 'UUFUUFUUFRRRRRRRRRFFDFFDFFDDDBDDBDDBLLLLLLLLLUBBUBBUBB');
  assert.equal(str('U'), 'UUUUUUUUUBBBRRRRRRRRRFFFFFFDDDDDDDDDFFFLLLLLLLLLBBBBBB');
  assert.equal(str('F'), 'UUUUUULLLURRURRURRFFFFFFFFFRRRDDDDDDLLDLLDLLDBBBBBBBBB');
});

test('每种转动阶数正确', () => {
  for (const m of ALL_MOVES) {
    const order = m.endsWith('2') ? 2 : 4;
    assert.ok(isSolved(applyMoves(solvedState(), parseAlg(Array(order).fill(m).join(' ')))), m);
    assert.ok(!isSolved(applyMoves(solvedState(), parseAlg(m))), m);
  }
});

test('经典公式周期', () => {
  assert.ok(isSolved(str2("R U R' U' ".repeat(6))));
  const ru = parseAlg('R U');
  let s = solvedState();
  let n = 0;
  do { s = applyMoves(s, ru); n++; } while (!isSolved(s));
  assert.equal(n, 105);
});
function str2(alg: string) { return applyMoves(solvedState(), parseAlg(alg)); }

test('打乱后逆序可复原', () => {
  for (let i = 0; i < 50; i++) {
    const sc = randomScramble(25);
    const s = applyMoves(solvedState(), sc);
    assert.ok(!isSolved(s));
    assert.ok(isSolved(applyMoves(s, invertAlg(sc))));
  }
});

test('解析', () => {
  assert.deepEqual(parseMove("R'"), { face: 'R', amount: -1 });
  assert.deepEqual(parseMove('U2'), { face: 'U', amount: 2 });
  assert.equal(parseMove('X'), null);
});


test('N 阶：2～5 阶的转动阶数、颜色守恒、打乱可逆', async () => {
  const { CUBE_SIZES, correctStickers } = await import('./cube.ts');
  for (const n of CUBE_SIZES) {
    for (const m of ALL_MOVES) {
      const order = m.endsWith('2') ? 2 : 4;
      assert.ok(isSolved(applyMoves(solvedState(n), parseAlg(Array(order).fill(m).join(' ')))), `${n} ${m}`);
      assert.ok(!isSolved(applyMoves(solvedState(n), parseAlg(m))), `${n} ${m}`);
    }
    for (let i = 0; i < 20; i++) {
      const sc = randomScramble(15, Math.random, n);
      const s = applyMoves(solvedState(n), sc);
      assert.equal(s.length, 6 * n * n);
      for (const f of ['U', 'R', 'F', 'D', 'L', 'B']) assert.equal(s.filter((x) => x === f).length, n * n);
      assert.ok(!isSolved(s));
      assert.ok(isSolved(applyMoves(s, invertAlg(sc))));
    }
    assert.equal(correctStickers(solvedState(n)), 6 * n * n);
  }
});

test('二阶 R：U 面右列变为 F 色', () => {
  const s = applyMoves(solvedState(2), parseAlg('R'));
  assert.deepEqual(s.slice(0, 4), ['U', 'F', 'U', 'F']);
});
