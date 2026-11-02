# SignalEscrow — pay-per-signal on Bitcoin Cash

> **Pre-hackathon prototype.** Built and tested on chipnet on 2026-10-28, before
> BCH BLAZE 2026 started. It is published as the "before" state of the BLAZE
> project: contracts, tests and a command-line chipnet run, with no app and no
> wallet connection. What is new during BLAZE is listed in the BLAZE repo.

A subscriber locks BCH (or a CashToken stablecoin such as PUSD) in a covenant.
The signal provider can take a fixed price, at most once per interval, and only
by publishing the signal's hash on chain. The subscriber can take everything
back at any time.

No server holds the money. The rules are enforced by the contract itself.

## Rules enforced on chain

| Rule | How |
|---|---|
| Only the provider can charge | provider pubkey hash + signature |
| Exact price, paid to the provider | `tx.outputs[0]` locking bytecode and value (token amount in the PUSD version) |
| At most one charge per interval | relative timelock `this.age >= minInterval` (BIP68) |
| The rest goes back to the same escrow | `tx.outputs[1]` must equal the input's locking bytecode, minus at most `maxFee` |
| Every charge publishes the signal | `tx.outputs[2]` must be OP_RETURN with the 32-byte signal hash |
| Nothing else is paid out | exactly 3 outputs (and 1 input in the token version) |
| Subscriber can always leave | `refund` needs only the subscriber's signature |

## Contracts

- `SignalEscrow.cash` — priced in BCH satoshis
- `SignalEscrowToken.cash` — priced in a fungible CashToken (e.g. PUSD)

## Tests

```
npm install
npm run build
npm test        # 12/12 (BCH) and 8/8 (token) on the CashScript mock network
```

Each "REJECT" test requires the contract itself to reject the transaction,
not a fee or builder check.

## Live run on chipnet (2026-10-28)

Escrow address: `bchtest:pdsr3y2ymn48a4kkar82ydfwzgvr3ggtv9glqpe75h4t7e4n9rgsy2t5zrkmc`
Settings: price 10,000 sats, interval 6 blocks, max fee 2,000 sats.

| Step | Result | Transaction |
|---|---|---|
| 1. Subscriber deposits 50,000 sats | accepted | [978f22fc…f420](https://chipnet.imaginary.cash/tx/978f22fc35a516bba39896734dea15d1dc9683d86a3314e8761b0261717df420) |
| 2. Provider charges before 6 blocks | rejected by the network: `non-BIP68-final` | — |
| 3. Provider charges "BUY ETH" after 6 blocks | accepted: 10,000 sats to provider, 39,000 back to escrow, sha256 `2f9d7cdb…4374` in OP_RETURN | [45dac64b…df3b](https://chipnet.imaginary.cash/tx/45dac64bd15004fe40a1c4ec3fe3423134814a070a0f0a5969cc71c62aacdf3b) |
| 4. Provider charges "SELL ETH" right away | rejected by the network: `non-BIP68-final` (the interval restarts with every charge) | — |
| 5. Subscriber refunds | accepted: escrow emptied, 38,000 sats back to the subscriber | [92fee9c3…93eb](https://chipnet.imaginary.cash/tx/92fee9c392aff02596a907f811e8731e10b082ef77b2a163dc60ed426d7f93eb) |

Anyone can check a signal: `sha256("BUY ETH")` =
`2f9d7cdb0021a365f6b9911ec063c0a06860fcddc2fb15f909d3b399be404374`,
the same value stored in the charge transaction.

Reproduce with `chipnet.mjs` (`keygen`, `status`, `deposit`, `charge`, `refund`).
Keys are kept in `.env` (chmod 600, git-ignored) and are never printed.
