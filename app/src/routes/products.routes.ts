import { Router } from "express";
import { listProducts, getProduct } from "../controllers/products.controller.js";

import { searchProducts } from "../controllers/search.controller.js";

import { updateProduct } from "../controllers/product-update.controller.js";

const routes = Router();

routes.get("/", listProducts);

routes.get("/search", searchProducts);

routes.get("/:id", getProduct);
routes.patch("/:id", updateProduct);

export default routes;
