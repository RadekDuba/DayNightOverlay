/**
 * DayNightOverlay - A standalone, wrap-safe Day/Night shadow overlay plugin for MapLibre GL JS & MapTiler SDK.
 * 
 * Computes astronomically precise solar positions and sweeps a smooth, continuous
 * terminator polygon across the globe, completely free of dateline wrapping or polar glitches.
 * 
 * @example
 * // Basic usage:
 * const dayNight = new DayNightOverlay(map);
 * dayNight.update(new Date());
 * 
 * // Advanced customization:
 * const dayNight = new DayNightOverlay(map, {
 *   fillColor: '#010510',
 *   fillOpacity: 0.50,
 *   resolution: 4 // coordinates per degree longitude (higher resolution = smoother shadow edge)
 * });
 */
class DayNightOverlay {
  /**
   * @param {object} map - MapLibre or MapTiler map instance.
   * @param {object} [options] - Custom rendering parameters.
   */
  constructor(map, options = {}) {
    if (!map) {
      throw new Error("DayNightOverlay requires a MapLibre GL JS or MapTiler SDK map instance.");
    }
    this.map = map;
    this.options = Object.assign({
      sourceId: 'daynight-shadow-source',
      layerId: 'daynight-shadow-layer',
      fillColor: '#030712',
      fillOpacity: 0.45,
      resolution: 2, // points per degree longitude (resolution: 2 sweeps with 720 longitude points)
      visible: true
    }, options);

    this.visible = this.options.visible;
    this._initialized = false;
    this._init();
  }

  /**
   * Initializes the map source and layer for rendering.
   * @private
   */
  _init() {
    if (this.map.isStyleLoaded()) {
      this._setupLayer();
    } else {
      this.map.on('load', () => this._setupLayer());
    }
  }

  /**
   * Adds the GeoJSON source and fill layer to the map.
   * @private
   */
  _setupLayer() {
    if (!this.map || this._initialized) return;

    // Safety check: if source already exists, just bind and return
    if (this.map.getSource(this.options.sourceId)) {
      this._initialized = true;
      return;
    }

    this.map.addSource(this.options.sourceId, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: []
      }
    });

    this.map.addLayer({
      id: this.options.layerId,
      type: 'fill',
      source: this.options.sourceId,
      paint: {
        'fill-color': this.options.fillColor,
        'fill-opacity': this.options.fillOpacity
      }
    });

    this.map.setLayoutProperty(
      this.options.layerId,
      'visibility',
      this.visible ? 'visible' : 'none'
    );

    this._initialized = true;
  }

  /**
   * Update the day/night shadow overlay for a given Date.
   * @param {Date|number|string} time - The timestamp or Date object to calculate the solar shadow for.
   */
  update(time) {
    if (!this.map) return;
    
    // Auto-setup if initialized lazily or delayed by style loads
    if (!this._initialized) {
      this._setupLayer();
      if (!this._initialized) return;
    }

    if (!this.visible) {
      this._clearShadow();
      return;
    }

    const date = time instanceof Date ? time : new Date(time);
    if (isNaN(date.getTime())) {
      console.warn("DayNightOverlay.update(): Invalid date provided.", time);
      return;
    }

    const nightFeature = this._createNightPolygon(date);
    const source = this.map.getSource(this.options.sourceId);
    if (source) {
      source.setData({
        type: 'FeatureCollection',
        features: [nightFeature]
      });
    }
  }

  /**
   * Toggle the visibility of the day/night overlay.
   * @param {boolean} visible - True to render the shadow, false to hide/disable.
   */
  setVisible(visible) {
    this.visible = !!visible;
    
    if (this.map && this.map.getLayer(this.options.layerId)) {
      this.map.setLayoutProperty(
        this.options.layerId,
        'visibility',
        this.visible ? 'visible' : 'none'
      );
    }

    // Immediately clear coordinates if turned off, or trigger update on next frame
    if (!this.visible) {
      this._clearShadow();
    }
  }

  /**
   * Clears the current shadow polygon from the map source.
   * @private
   */
  _clearShadow() {
    const source = this.map ? this.map.getSource(this.options.sourceId) : null;
    if (source) {
      source.setData({
        type: 'FeatureCollection',
        features: []
      });
    }
  }

  /**
   * Calculates high-precision solar coordinates.
   * @param {Date} date
   * @returns {object} { gst, alpha, delta }
   * @private
   */
  _getSolarPosition(date) {
    const today = date ? new Date(date) : new Date();
    const julianDay = (today / 86400000) + 2440587.5;
    const d = julianDay - 2451545.0;
    const gst = (18.697374558 + 24.06570982441908 * d) % 24;

    const n = julianDay - 2451545.0;
    let L = 280.460 + 0.9856474 * n;
    L %= 360;
    let g = 357.528 + 0.9856003 * n;
    g %= 360;
    const lambda = L + 1.915 * Math.sin(g * Math.PI / 180) + 0.02 * Math.sin(2 * g * Math.PI / 180);
    
    const T = n / 36525;
    const eclObliq = 23.43929111 - T * (46.836769 / 3600 - T * (0.0001831 / 3600 + T * (0.00200340 / 3600 - T * (0.576e-6 / 3600 - T * 4.34e-8 / 3600))));
    
    let alpha = Math.atan(Math.cos(eclObliq * Math.PI / 180) * Math.tan(lambda * Math.PI / 180)) * 180 / Math.PI;
    const delta = Math.asin(Math.sin(eclObliq * Math.PI / 180) * Math.sin(lambda * Math.PI / 180)) * 180 / Math.PI;

    const lQuadrant = Math.floor(lambda / 90) * 90;
    const raQuadrant = Math.floor(alpha / 90) * 90;
    alpha = alpha + (lQuadrant - raQuadrant);

    return { gst, alpha, delta };
  }

  /**
   * Calculates the subsolar point for a given date.
   * @param {Date} date
   * @returns {[number, number]} [longitude, latitude] of the subsolar point.
   */
  getSubsolarPoint(date) {
    const { gst, alpha, delta } = this._getSolarPosition(date);
    const lon = ((alpha - gst * 15 + 180) % 360 + 360) % 360 - 180;
    return [lon, delta];
  }

  /**
   * Generates the night hemisphere GeoJSON polygon utilizing a polar-sweep method.
   * @param {Date} date
   * @private
   */
  _createNightPolygon(date) {
    const { gst, alpha, delta } = this._getSolarPosition(date);
    const coordinates = [];
    const res = Math.max(0.01, this.options.resolution || 2);
    const steps = Math.round(360 * res);

    // Sweeping sequentially from longitude -180 to 180 degrees.
    // We use integer steps to calculate exact longitude and avoid floating-point rounding drift.
    for (let i = 0; i <= steps; i++) {
      const lng = -180 + (i * 360) / steps;
      const lst = gst + lng / 15;
      const ha = lst * 15 - alpha;
      const lat = Math.atan(-Math.cos(ha * Math.PI / 180) / Math.tan(delta * Math.PI / 180)) * 180 / Math.PI;
      coordinates.push([lng, lat]);
    }

    // Close the polygon ring over the dark pole
    if (delta < 0) {
      coordinates.push([180, 90]);
      coordinates.push([-180, 90]);
    } else {
      coordinates.push([180, -90]);
      coordinates.push([-180, -90]);
    }
    coordinates.push(coordinates[0]);

    return {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [coordinates]
      },
      properties: {}
    };
  }
}
