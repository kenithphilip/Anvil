// GET / PUT /api/oracle_ebs/field_map - tenant-configurable field overrides for SO push.

import { connectorFieldMapHandler } from "../_lib/connector-fieldmap.js";

export default connectorFieldMapHandler("oracle_ebs_field_map", "oracle_ebs_field_map_updated");
