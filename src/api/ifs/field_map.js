// GET / PUT /api/ifs/field_map - tenant-configurable field overrides for SO push.

import { connectorFieldMapHandler } from "../_lib/connector-fieldmap.js";

export default connectorFieldMapHandler("ifs_field_map", "ifs_field_map_updated");
