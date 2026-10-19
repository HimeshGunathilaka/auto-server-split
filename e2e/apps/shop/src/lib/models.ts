import type { HydratedDocument, Types } from "mongoose";

export interface IProduct {
  _id: Types.ObjectId;
  name: string;
  price: number;
  categoryId: Types.ObjectId | null;
}

export interface IPost {
  _id: Types.ObjectId;
  title: string;
  body: string;
  likes: number;
  createdAt: Date;
  author: { name: string; id: Types.ObjectId };
}

export type PostDoc = HydratedDocument<IPost>;
