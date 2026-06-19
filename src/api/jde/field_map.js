// GET / PUT /api/jde/field_map - tenant-configurable field overrides for SO push.

import { connectorFieldMapHandler } from "../_lib/connector-fieldmap.js";

export default connectorFieldMapHandler("jde_field_map", "jde_field_map_updated");
