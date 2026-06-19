// GET / PUT /api/ramco/field_map - tenant-configurable field overrides for SO push.

import { connectorFieldMapHandler } from "../_lib/connector-fieldmap.js";

export default connectorFieldMapHandler("ramco_field_map", "ramco_field_map_updated");
