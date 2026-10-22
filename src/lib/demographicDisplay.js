export function demographicNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function asianDatasetMatchesCityReference(dataset, cityReference) {
  const binding = dataset?.baseCityReference;
  const cityProfiles = Object.keys(cityReference?.placesByGeoid || {}).length;
  return dataset?.schema === "byou-costco-city-asian-demographics-v1"
    && binding?.schema === cityReference?.schema
    && binding?.datasetVersion === cityReference?.datasetVersion
    && binding?.generatedAt === cityReference?.generatedAt
    && Number(binding?.vintageYear) === Number(cityReference?.vintage?.year)
    && Number(binding?.uniqueCityProfiles) === cityProfiles;
}

export function asianDatasetMatchesMarketDirectory(dataset, directory) {
  const binding = dataset?.baseMarketDirectory;
  const stores = Array.isArray(directory?.stores) ? directory.stores : [];
  const usWarehouses = stores.filter(store => store?.country === "US").length;
  return dataset?.schema === "byou-costco-five-mile-asian-demographics-v1"
    && binding?.schema === directory?.schema
    && binding?.generatedAt === directory?.generatedAt
    && Number(binding?.totalWarehouses) === stores.length
    && Number(binding?.usWarehouses) === usWarehouses;
}

export function rankedAsianGroupRows(profile, definitions = []) {
  return definitions.map(definition => ({
    ...definition,
    count:profile?.groups?.[definition.id]?.count || null,
    shareOfTotalPopulation:profile?.groups?.[definition.id]?.shareOfTotalPopulation || null,
  })).sort((a, b) => {
    const aValue = demographicNumber(a.shareOfTotalPopulation?.estimate);
    const bValue = demographicNumber(b.shareOfTotalPopulation?.estimate);
    if (aValue === null && bValue !== null) return 1;
    if (aValue !== null && bValue === null) return -1;
    if (aValue !== bValue) return (bValue || 0) - (aValue || 0);
    return String(a.label || a.id).localeCompare(String(b.label || b.id));
  });
}
