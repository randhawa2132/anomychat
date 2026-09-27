const maxSubscriptionsPerAccount = 10;

export function trimSubscriptions(subscriptions, owner) {
  const owned = Object.keys(subscriptions).filter((key) => subscriptions[key].owner === owner);
  for (const key of owned.slice(0, -maxSubscriptionsPerAccount)) delete subscriptions[key];
}
