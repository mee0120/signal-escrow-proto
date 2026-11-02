// Offline tests for SignalEscrowToken (PUSD-style fungible token) on the CashScript mock network.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo, randomToken } from 'cashscript';
import { secp256k1, hash160, generatePrivateKey, encodeLockingBytecodeP2pkh, binToHex, hexToBin, sha256, utf8ToBin, swapEndianness } from '@bitauth/libauth';

const artifact = JSON.parse(readFileSync(new URL('./SignalEscrowToken.json', import.meta.url)));
const wallet = () => { const priv = generatePrivateKey(); const pub = secp256k1.derivePublicKeyCompressed(priv); const pkh = hash160(pub); return { pub, pkh, lock: encodeLockingBytecodeP2pkh(pkh), sig: new SignatureTemplate(priv) }; };

const PRICE = 100n;          // token units (e.g. 1.00 PUSD if 2 decimals)
const DEPOSIT_TOKENS = 1_000n;
const INTERVAL = 6n, MAX_FEE = 2_000n, DUST = 1_000n, DEPOSIT_SATS = 20_000n;
const hashOf = (t) => binToHex(sha256.hash(utf8ToBin(t)));

function setup(categoryOverride) {
  const provider = new MockNetworkProvider();
  const sub = wallet(), prov = wallet();
  const token = randomToken({ amount: DEPOSIT_TOKENS });
  // Introspection returns the category in internal (reversed) byte order.
  const contract = new Contract(artifact, [sub.pkh, prov.pkh, hexToBin(swapEndianness(categoryOverride ?? token.category)), PRICE, INTERVAL, MAX_FEE, DUST], { provider, addressType: 'p2sh32' });
  const utxo = provider.addUtxo(contract.address, randomUtxo({ satoshis: DEPOSIT_SATS, token }));
  return { provider, sub, prov, contract, utxo, category: token.category };
}

function charge(s, o = {}) {
  const fee = o.fee ?? 1_000n, price = o.price ?? PRICE, cat = o.category ?? s.category;
  const tb = new TransactionBuilder({ provider: s.provider, allowImplicitFungibleTokenBurn: !!o.allowBurn })
    .addInput(s.utxo, s.contract.unlock.charge(s.prov.pub, s.prov.sig, hashOf('BUY ETH')), { sequence: Number(o.sequence ?? INTERVAL) })
    .addOutput({ to: o.payTo ?? s.prov.lock, amount: DUST, token: { category: cat, amount: price } })
    .addOutput({ to: s.contract.tokenAddress, amount: s.utxo.satoshis - DUST - fee, token: { category: s.category, amount: s.utxo.token.amount - (o.keep ?? price) } })
    .addOpReturnOutput(['0x' + hashOf('BUY ETH')]);
  return tb;
}

const results = [];
const check = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); } };
const expectFail = async (build) => {
  try { await build().send(); } catch (e) {
    if (/FailedRequireError|FailedTransactionEvaluationError/.test(e.constructor.name)) return;
    throw new Error('rejected for the wrong reason: ' + e.constructor.name + ' ' + e.message.split('\n')[0]);
  }
  throw new Error('was not rejected');
};

await check('provider charges 1 signal in tokens; the rest stays in escrow', async () => {
  const s = setup();
  await charge(s).send();
  const [left] = await s.provider.getUtxos(s.contract.address);
  assert.equal(left.token.amount, DEPOSIT_TOKENS - PRICE);
});
await check('REJECT: too early', () => expectFail(() => charge(setup(), { sequence: INTERVAL - 1n })));
await check('REJECT: takes more tokens than the price', () => expectFail(() => charge(setup(), { price: PRICE * 2n, keep: PRICE * 2n })));
await check('REJECT: keeps tokens back (escrow short-changed)', () => expectFail(() => charge(setup(), { keep: PRICE * 3n, allowBurn: true })));
await check('REJECT: pays the price to someone else', () => { const s = setup(); return expectFail(() => charge(s, { payTo: s.sub.lock })); });
await check('REJECT: fee above maxFee', () => expectFail(() => charge(setup(), { fee: MAX_FEE + 1n })));
await check('REJECT: escrow configured for a different token', () => expectFail(() => charge(setup(randomToken().category))));
await check('subscriber refunds tokens and BCH', async () => {
  const s = setup();
  await new TransactionBuilder({ provider: s.provider })
    .addInput(s.utxo, s.contract.unlock.refund(s.sub.pub, s.sub.sig))
    .addOutput({ to: s.sub.lock, amount: DEPOSIT_SATS - 1_000n, token: { category: s.category, amount: DEPOSIT_TOKENS } }).send();
  assert.equal((await s.provider.getUtxos(s.contract.address)).length, 0);
});

for (const r of results) console.log(r.join(' | '));
const failed = results.filter(r => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
