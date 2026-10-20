import type { HydratedDocument, Types } from "mongoose";

export interface IPost {
  _id: Types.ObjectId;
  title: string;
  body: string;
  likes: number;
  createdAt: Date;
  author: { name: string; id: Types.ObjectId };
}

export type PostDoc = HydratedDocument<IPost>;
