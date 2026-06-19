// GET / PUT /api/plex/field_map - tenant-configurable field overrides for SO push.

import { connectorFieldMapHandler } from "../_lib/connector-fieldmap.js";

export default connectorFieldMapHandler("plex_field_map", "plex_field_map_updated");
