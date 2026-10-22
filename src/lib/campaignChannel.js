function normalizedChannel(value) {
  return String(value || "").toLowerCase().trim();
}

function compactChannel(value) {
  return normalizedChannel(value).replace(/[^a-z0-9]+/g, "");
}

function isBothChannel(value) {
  const channel = normalizedChannel(value);
  return /\b(both|all channels|omni[\s-]?channel)\b/.test(channel);
}

function isInlineChannel(value) {
  const channel = compactChannel(value);
  return channel.includes("inline") || channel === "costco";
}

function isOnlineChannel(value) {
  const channel = compactChannel(value);
  return channel.includes("online") || channel.includes("ecommerce") || channel === "dtc";
}

export function campaignChannelSupports(campaignChannel, requestedChannel) {
  const campaign = normalizedChannel(campaignChannel);
  const requested = normalizedChannel(requestedChannel);
  if (!campaign || !requested || isBothChannel(campaign)) return true;

  if (isInlineChannel(requested)) return isInlineChannel(campaign);
  if (isOnlineChannel(requested)) return isOnlineChannel(campaign);

  const campaignKey = compactChannel(campaign);
  const requestedKey = compactChannel(requested);
  return campaignKey.includes(requestedKey) || requestedKey.includes(campaignKey);
}
