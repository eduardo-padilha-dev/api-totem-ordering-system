import { Router } from "express";
import { getCart, putCartItem, deleteCartItem } from "../controllers/cart.controller.js";

const routes = Router();
routes.get("/", getCart);
routes.put("/items/:productId", putCartItem);
routes.delete("/items/:productId", deleteCartItem);

export default routes;
