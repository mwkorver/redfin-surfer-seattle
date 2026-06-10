const DiligenceScoring = Object.freeze({
  topics: Object.freeze({
    crime: Object.freeze({
      label: "Crime",
      weight: 0.60
    }),
    lightRail: Object.freeze({
      label: "Light Rail",
      weight: 0.40
    })
  }),

  getTopic(key) {
    return this.topics[key] || null;
  }
});
