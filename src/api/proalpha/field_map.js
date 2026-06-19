// GET / PUT /api/proalpha/field_map - tenant-configurable field overrides for SO push.

import { connectorFieldMapHandler } from "../_lib/connector-fieldmap.js";

export default connectorFieldMapHandler("proalpha_field_map", "proalpha_field_map_updated");
