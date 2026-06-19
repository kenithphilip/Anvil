// GET / PUT /api/jobboss/field_map - tenant-configurable field overrides for SO push.

import { connectorFieldMapHandler } from "../_lib/connector-fieldmap.js";

export default connectorFieldMapHandler("jobboss_field_map", "jobboss_field_map_updated");
