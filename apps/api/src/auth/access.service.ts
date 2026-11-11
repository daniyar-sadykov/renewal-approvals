import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { forbidden } from '../common/api-error';
import { DatabaseService } from '../database/database.service';

export interface Membership {
  workspaceId: string;
  workspaceName: string;
  canInitiate: boolean;
  canApprove: boolean;
}

// Запросы идут либо через пул, либо через client открытой транзакции.
export type Queryable ={ query: PoolClient['query'] };

// Права пользователя в пространстве. Источник истины: таблица memberships.
@Injectable()
export class AccessService {
  constructor(private readonly db: DatabaseService) {}

  async listMemberships(userId: string): Promise<Membership[]> {
    const { rows } = await this.db.query(
      `select m.workspace_id, w.name as workspace_name, m.can_initiate, m.can_approve
         from memberships m join workspaces w on w.id = m.workspace_id
        where m.user_id = $1
        order by w.name`,
      [userId],
    );
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      canInitiate: row.can_initiate,
      canApprove: row.can_approve,
    }));
  }

  // null, если пользователь не член пространства. В транзакции передавать её client.
  async findMembership(userId: string, workspaceId: string, client: Queryable = this.db.pool): Promise<Membership | null> {
    const { rows } = await client.query(
      `select m.workspace_id, w.name as workspace_name, m.can_initiate, m.can_approve
         from memberships m join workspaces w on w.id = m.workspace_id
        where m.user_id = $1 and m.workspace_id = $2`,
      [userId, workspaceId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      canInitiate: row.can_initiate,
      canApprove: row.can_approve,
    };
  }

  // Членство обязательно: иначе 403 (чужое пространство).
  async requireMembership(userId: string, workspaceId: string, client: Queryable = this.db.pool): Promise<Membership> {
    const membership = await this.findMembership(userId, workspaceId, client);
    if (!membership) throw forbidden('Нет доступа к этому пространству');
    return membership;
  }
}
