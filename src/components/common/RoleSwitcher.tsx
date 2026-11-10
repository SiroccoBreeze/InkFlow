import React from 'react';
import { UserRole, UserSession } from '../../types';
import { storage } from '../../services/storage';

interface RoleSwitcherProps {
  session: UserSession;
  onRoleChanged: () => void;
}

export const RoleSwitcher: React.FC<RoleSwitcherProps> = ({
  session,
  onRoleChanged,
}) => {
  const handleSelectRole = (role: UserRole) => {
    if (role === 'owner' && (!session.token || !session.isOwner)) {
      window.dispatchEvent(new CustomEvent('inkflow:request-login'));
      return;
    }
    storage.switchRole(role);
    onRoleChanged();
  };


  return (
    <div className="flex items-center gap-1.5 p-1 bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg text-xs">
      <span className="text-[10px] text-neutral-400 px-1 font-mono uppercase tracking-wider">
        角色沙盒:
      </span>
      <button
        onClick={() => handleSelectRole('owner')}
        className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
          session.role === 'owner'
            ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 shadow-xs'
            : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
        }`}
        title="主理人模式：拥有完整文档增删改查、私密文档与系统权限"
      >
        👑 主理人
      </button>
      <button
        onClick={() => handleSelectRole('contributor')}
        className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
          session.role === 'contributor'
            ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 shadow-xs'
            : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
        }`}
        title="共创者模式：可参与论坛研讨、发起议题与批注"
      >
        ✍️ 共创者
      </button>
      <button
        onClick={() => handleSelectRole('reader')}
        className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
          session.role === 'reader'
            ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 shadow-xs'
            : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
        }`}
        title="读者模式：沉浸式浏览公开文献与发表想法"
      >
        👓 访客读者
      </button>
    </div>
  );
};
