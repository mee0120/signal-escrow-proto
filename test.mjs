// Offline tests for SignalEscrow on the CashScript mock network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo } from 'cashscript';
import { secp256k1, hash160, generatePrivateKey, encodeLockingBytecodeP2pkh, binToHex, sha256, utf8ToBin } from '@bitauth/libauth';

const artifact = JSON.parse(readFileSync(new URL('./SignalEscrow.json', import.meta.url)));

function wallet() {
  const priv = generatePrivateKey();
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  const pkh = hash160(pub);
  return { priv, pub, pkh, lock: encodeLockingBytecodeP2pkh(pkh), sig: new SignatureTemplate(priv) };
}

const PRICE = 10_000n;
const INTERVAL = 6n;      // blocks (~1 hour)
const MAX_FEE = 2_000n;
const DEPOSIT = 100_000n;

function setup() {
  const provider = new MockNetworkProvider();
  const sub = wallet();
  const prov = wallet();
  const contract = new Contract(artifact, [sub.pkh, prov.pkh, PRICE, INTERVAL, MAX_FEE], { provider, addressType: 'p2sh32' });
  const utxo = provider.addUtxo(contract.address, randomUtxo({ satoshis: DEPOSIT }));
  return { provider, sub, prov, contract, utxo };
}

const signalHash = (text) => binToHex(sha256.hash(utf8ToBin(text)));

function chargeTx({ provider, prov, contract, utxo }, opts = {}) {
  const fee = opts.fee ?? 1_000n;
  const tb = new TransactionBuilder({ provider })
    .addInput(utxo, contract.unlock.charge(prov.pub, prov.sig, opts.hash ?? signalHash('BUY ETH 2026-11-01T00:00Z')),
      { sequence: Number(opts.sequence ?? INTERVAL) })
    .addOutput({ to: opts.payTo ?? prov.lock, amount: opts.price ?? PRICE })
    .addOutput({ to: opts.backTo ?? contract.address, amount: utxo.satoshis - (opts.price ?? PRICE) - fee - (opts.extraOutput ? 1_000n : 0n) });
  if (!opts.noOpReturn) tb.addOpReturnOutput(['0x' + (opts.hash ?? signalHash('BUY ETH 2026-11-01T00:00Z'))]);
  if (opts.extraOutput) tb.addOutput({ to: prov.lock, amount: 1_000n });
  return tb;
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); }
}
// Must be rejected by the contract itself, not by a fee or builder check.
async function expectFail(build) {
  try { await build().send(); } catch (e) {
    if (/FailedRequireError|FailedTransactionEvaluationError/.test(e.constructor.name)) return;
    throw new Error('rejected for the wrong reason: ' + e.constructor.name);
  }
  throw new Error('was not rejected');
}

await check('provider charges one signal; remainder stays in escrow; hash recorded', async () => {
  const s = setup();
  const tx = await chargeTx(s).send();
  const left = await s.provider.getUtxos(s.contract.address);
  assert.equal(left.length, 1);
  assert.equal(left[0].satoshis, DEPOSIT - PRICE - 1_000n);
  assert.ok(tx.txid);
});

await check('charge again from the new escrow UTXO (second signal)', async () => {
  const s = setup();
  await chargeTx(s).send();
  const [next] = await s.provider.getUtxos(s.contract.address);
  await chargeTx({ ...s, utxo: next }, { hash: signalHash('SELL ETH') }).send();
  const [after] = await s.provider.getUtxos(s.contract.address);
  assert.equal(after.satoshis, DEPOSIT - 2n * (PRICE + 1_000n));
});

await check('REJECT: charging before the interval (sequence too low)', () => expectFail(() => chargeTx(setup(), { sequence: INTERVAL - 1n })));
await check('REJECT: provider takes more than the price', () => expectFail(() => chargeTx(setup(), { price: PRICE * 2n })));
await check('REJECT: price sent to someone else', () => { const s = setup(); return expectFail(() => chargeTx(s, { payTo: s.sub.lock })); });
await check('REJECT: remainder not returned to the escrow', () => { const s = setup(); return expectFail(() => chargeTx(s, { backTo: s.prov.lock })); });
await check('REJECT: fee above maxFee (provider skims via fee)', () => expectFail(() => chargeTx(setup(), { fee: MAX_FEE + 1n })));
await check('REJECT: no signal hash published', () => expectFail(() => chargeTx(setup(), { noOpReturn: true })));
await check('REJECT: extra output', () => expectFail(() => chargeTx(setup(), { extraOutput: true })));
await check('REJECT: subscriber key cannot charge', async () => {
  const s = setup();
  await assert.rejects(() => new TransactionBuilder({ provider: s.provider })
    .addInput(s.utxo, s.contract.unlock.charge(s.sub.pub, s.sub.sig, signalHash('x')), { sequence: Number(INTERVAL) })
    .addOutput({ to: s.prov.lock, amount: PRICE })
    .addOutput({ to: s.contract.address, amount: DEPOSIT - PRICE - 1_000n })
    .addOpReturnOutput(['0x' + signalHash('x')]).send());
});

await check('subscriber refunds everything at any time', async () => {
  const s = setup();
  await new TransactionBuilder({ provider: s.provider })
    .addInput(s.utxo, s.contract.unlock.refund(s.sub.pub, s.sub.sig))
    .addOutput({ to: s.sub.lock, amount: DEPOSIT - 1_000n }).send();
  assert.equal((await s.provider.getUtxos(s.contract.address)).length, 0);
});
await check('REJECT: provider cannot use refund', async () => {
  const s = setup();
  await assert.rejects(() => new TransactionBuilder({ provider: s.provider })
    .addInput(s.utxo, s.contract.unlock.refund(s.prov.pub, s.prov.sig))
    .addOutput({ to: s.prov.lock, amount: DEPOSIT - 1_000n }).send());
});

for (const r of results) console.log(r.join(' | '));
const failed = results.filter(r => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
