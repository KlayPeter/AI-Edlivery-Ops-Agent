import { DatePicker, Select, Space, Button, Tabs } from 'antd';
import dayjs from 'dayjs';
import { ALL_CONTEXT_TYPES, getTypeName } from './utils';

const { RangePicker } = DatePicker;

export const ContextsFilter = ({ filters, setFilters, members, groups, handleSearch, handleReset, handleTabChange }: any) => {
  return (
    <>
      <div style={{ marginBottom: 16, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <RangePicker 
          value={filters.startDate ? [dayjs(filters.startDate), dayjs(filters.endDate)] : null}
          onChange={(dates: any) => {
            if (dates) {
              setFilters({...filters, startDate: dates[0].format('YYYY-MM-DD'), endDate: dates[1].format('YYYY-MM-DD')});
            } else {
              setFilters({...filters, startDate: null, endDate: null});
            }
          }}
        />
        <Select
          style={{ width: 150 }}
          value={filters.contextType}
          onChange={(val) => setFilters({...filters, contextType: val})}
        >
          <Select.Option value="all">所有事件类型</Select.Option>
          {ALL_CONTEXT_TYPES.map(type => (
            <Select.Option key={type} value={type}>{getTypeName(type)}</Select.Option>
          ))}
        </Select>
        {filters.chatType === 'private' && (
          <Select
            style={{ width: 120 }}
            value={filters.targetOpenId}
            onChange={(val) => setFilters({...filters, targetOpenId: val})}
          >
            <Select.Option value="all">所有人员</Select.Option>
            {members.map((m: any) => (
              <Select.Option key={m.open_id} value={m.open_id}>{m.name}</Select.Option>
            ))}
          </Select>
        )}
        
        <Select
          style={{ width: 150 }}
          value={filters.groupId}
          onChange={(val) => setFilters({...filters, groupId: val})}
          placeholder="筛选群聊"
        >
          <Select.Option value="all">所有群聊</Select.Option>
          {groups.map((g: any) => <Select.Option key={g.chat_id} value={g.chat_id}>{g.name || g.chat_id}</Select.Option>)}
        </Select>

        <Space>
          <Button type="primary" onClick={handleSearch}>查询</Button>
          <Button onClick={handleReset}>重置</Button>
        </Space>
      </div>
      
      <Tabs 
        activeKey={filters.chatType} 
        onChange={handleTabChange}
        items={[
          { key: 'private', label: '私聊上下文' },
          { key: 'group', label: '群聊上下文' },
        ]}
        style={{ marginBottom: 16 }}
      />
    </>
  );
};
