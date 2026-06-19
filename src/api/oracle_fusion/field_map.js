// GET / PUT /api/oracle_fusion/field_map - tenant-configurable field overrides for SO push.

import { connectorFieldMapHandler } from "../_lib/connector-fieldmap.js";

export default connectorFieldMapHandler("oracle_fusion_field_map", "oracle_fusion_field_map_updated");
