const DiligenceScoring = Object.freeze({
  topics: Object.freeze({
    crime: Object.freeze({
      label: "Crime",
      weight: 0.40
    }),
    lightRail: Object.freeze({
      label: "Light Rail",
      weight: 0.20
    }),
    lotArea: Object.freeze({
      label: "Lot Area",
      weight: 0.20
    }),
    pricePerSqft: Object.freeze({
      label: "Price/Sq.Ft.",
      weight: 0.20
    })
  }),

  getTopic(key) {
    return this.topics[key] || null;
  }
});
