const DiligenceScoring = Object.freeze({
  topics: Object.freeze({
    permits: Object.freeze({
      label: "Permits",
      weight: 0.45
    }),
    crime: Object.freeze({
      label: "Crime",
      weight: 0.55
    })
  }),

  getTopic(key) {
    return this.topics[key] || null;
  }
});
