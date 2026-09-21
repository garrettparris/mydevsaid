import { TRANSFER_TOPIC, addressWord, type collectTransfers } from "./onchain.ts";

type Transfers = Awaited<ReturnType<typeof collectTransfers>>;
const ZERO = `0x${"0".repeat(40)}`;

/** Descriptive ERC-20 event patterns only; shared token senders are not proven common gas funders. */
export function analyzeTransfers(sample: Transfers) {
  const senders = new Map<string, number>();
  const recipients = new Map<string, Set<string>>();
  const pairs = new Map<string, number>();
  const amounts = new Map<string, number>();
  const unique = new Set<string>();
  const participants = new Set<string>();
  let transfers = 0, minted = 0, burned = 0, excluded = 0;
  for (const log of sample.logs) {
    const key = `${log.transactionHash.toLowerCase()}:${log.logIndex.toLowerCase()}`;
    if (unique.has(key)) { excluded++; continue; }
    unique.add(key);
    // ERC-721 uses the same topic but four indexed topics and must not inflate ERC-20 counts.
    if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || !/^0x[a-f0-9]{64}$/i.test(log.data)) { excluded++; continue; }
    const decode = (value: string | undefined) => /^0x0{64}$/.test(value ?? "") ? ZERO : addressWord(value);
    const from = decode(log.topics[1]), to = decode(log.topics[2]);
    if (!from || !to) { excluded++; continue; }
    if (from === ZERO) { minted++; continue; }
    if (to === ZERO) { burned++; continue; }
    transfers++;
    participants.add(from); participants.add(to);
    senders.set(from, (senders.get(from) ?? 0) + 1);
    const targets = recipients.get(from) ?? new Set<string>();
    targets.add(to); recipients.set(from, targets);
    const pair = `${from}:${to}`;
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
    const amount = BigInt(log.data).toString();
    amounts.set(amount, (amounts.get(amount) ?? 0) + 1);
  }
  const ranked = [...senders].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const reciprocalPairs = [...pairs.keys()].filter((pair) => {
    const [from, to] = pair.split(":");
    return from! < to! && pairs.has(`${to}:${from}`);
  }).slice(0, 20).map((pair) => pair.split(":"));
  return {
    fromBlock: sample.fromBlock, toBlock: sample.toBlock, observedLogs: sample.logs.length,
    transfers, mintEvents: minted, burnEvents: burned, excludedEvents: excluded, participants: participants.size,
    topSenderShare: transfers ? (ranked[0]?.[1] ?? 0) / transfers : null,
    topSenders: ranked.slice(0, 10).map(([address, count]) => ({ address, count })),
    sharedTokenSenders: [...recipients].filter(([, targets]) => targets.size >= 3)
      .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).slice(0, 10)
      .map(([address, targets]) => ({ address, distinctRecipients: targets.size, recipients: [...targets].sort().slice(0, 20) })),
    repeatedAmounts: [...amounts].filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([rawAmount, count]) => ({ rawAmount, count })),
    reciprocalPairs,
    limitations: [
      "Only up to 128 recent blocks and 500 token Transfer logs; this is not a lifetime activity analysis",
      "Transfer logs are contract-emitted claims; arbitrary contracts can emit misleading events",
      "Counts exclude mint/burn events and do not measure trades, independent people, volume, or revenue",
      "Shared token senders are not common gas funders; native funding history and transaction traces were not collected",
      "Exchanges, routers, incentives, and legitimate automation can create concentration and repeated patterns",
      "No organic-activity score or attribution of wallets to one owner is established",
    ],
  };
}
