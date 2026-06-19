// GET / PUT /api/sage_x3/field_map - tenant-configurable field overrides for SO push.

import { connectorFieldMapHandler } from "../_lib/connector-fieldmap.js";

export default connectorFieldMapHandler("sagex3_field_map", "sagex3_field_map_updated");
